// weavepack-wire — delta application (apply_chain, apply_op).
//
// Operates on decoded field arrays. Mirrors the JS apply.js logic.

use crate::types::{Field, FieldValue, Op, PathComp};

fn find_field(fields: &[Field], num: u32) -> Option<usize> {
    fields.iter().position(|f| f.num == num)
}

fn sort_fields(fields: &mut Vec<Field>) {
    fields.sort_by_key(|f| f.num);
}

// Navigate to the parent fields container (all path components except the last).
// Returns a mutable reference to the parent Vec<Field> and the last path component.
fn navigate_mut<'a>(
    fields: &'a mut Vec<Field>,
    path: &'a [PathComp],
) -> Result<(&'a mut Vec<Field>, Option<&'a PathComp>), String> {
    if path.is_empty() {
        return Ok((fields, None));
    }
    let (mid, last) = path.split_at(path.len() - 1);

    let mut current: *mut Vec<Field> = fields as *mut Vec<Field>;

    for comp in mid {
        match comp {
            PathComp::Field(n) => {
                let cur = unsafe { &mut *current };
                let idx = find_field(cur, *n)
                    .ok_or_else(|| format!("field {n} not found"))?;
                match &mut cur[idx].value {
                    FieldValue::Message(inner) => {
                        current = inner as *mut Vec<Field>;
                    }
                    _ => return Err(format!("field {n} is not a message")),
                }
            }
            _ => return Err("unsupported mid-path component".into()),
        }
    }

    Ok((unsafe { &mut *current }, last.first()))
}

fn apply_op(mut fields: Vec<Field>, op: &Op) -> Result<Vec<Field>, String> {
    match op {
        Op::FieldSet { path, value } => {
            let (parent, last_comp) = navigate_mut(&mut fields, path)?;
            if let Some(PathComp::Field(n)) = last_comp {
                let new_field = Field { num: *n, value: value.clone() };
                if let Some(idx) = find_field(parent, *n) {
                    parent[idx] = new_field;
                } else {
                    parent.push(new_field);
                    sort_fields(parent);
                }
            }
            Ok(fields)
        }

        Op::FieldDelete { path } => {
            let (parent, last_comp) = navigate_mut(&mut fields, path)?;
            if let Some(PathComp::Field(n)) = last_comp {
                if let Some(idx) = find_field(parent, *n) {
                    parent.remove(idx);
                }
            }
            Ok(fields)
        }

        Op::MessageReplace { path, message } => {
            if path.is_empty() {
                return Ok(message.clone());
            }
            let (parent, last_comp) = navigate_mut(&mut fields, path)?;
            if let Some(PathComp::Field(n)) = last_comp {
                let new_field = Field { num: *n, value: FieldValue::Message(message.clone()) };
                if let Some(idx) = find_field(parent, *n) {
                    parent[idx] = new_field;
                } else {
                    parent.push(new_field);
                    sort_fields(parent);
                }
            }
            Ok(fields)
        }

        Op::RepeatedAppend { path, elem_type, values } => {
            let (parent, last_comp) = navigate_mut(&mut fields, path)?;
            if let Some(PathComp::Field(n)) = last_comp {
                if let Some(idx) = find_field(parent, *n) {
                    match &mut parent[idx].value {
                        FieldValue::Repeated { values: existing, .. } => {
                            existing.extend_from_slice(values);
                        }
                        _ => return Err(format!("field {n} is not repeated")),
                    }
                } else {
                    parent.push(Field {
                        num: *n,
                        value: FieldValue::Repeated { elem_type: *elem_type, values: values.clone() },
                    });
                    sort_fields(parent);
                }
            }
            Ok(fields)
        }

        Op::RepeatedSplice { path, index, delete_count, elem_type: _, insert_values } => {
            let (parent, last_comp) = navigate_mut(&mut fields, path)?;
            if let Some(PathComp::Field(n)) = last_comp {
                let idx = find_field(parent, *n)
                    .ok_or_else(|| format!("repeated field {n} not found"))?;
                match &mut parent[idx].value {
                    FieldValue::Repeated { values, .. } => {
                        let start = *index as usize;
                        let delete = *delete_count as usize;
                        values.splice(start..start + delete, insert_values.iter().cloned());
                    }
                    _ => return Err(format!("field {n} is not repeated")),
                }
            }
            Ok(fields)
        }

        Op::MapSet { path, key_type, key, value_type, value } => {
            let (parent, last_comp) = navigate_mut(&mut fields, path)?;
            if let Some(PathComp::Field(n)) = last_comp {
                if let Some(idx) = find_field(parent, *n) {
                    match &mut parent[idx].value {
                        FieldValue::Map { entries, .. } => {
                            if let Some(ei) = entries.iter().position(|(k, _)| k == key) {
                                entries[ei].1 = value.clone();
                            } else {
                                entries.push((key.clone(), value.clone()));
                            }
                        }
                        _ => return Err(format!("field {n} is not a map")),
                    }
                } else {
                    parent.push(Field {
                        num: *n,
                        value: FieldValue::Map {
                            key_type: key_type.clone(),
                            value_type: *value_type,
                            entries: vec![(key.clone(), value.clone())],
                        },
                    });
                    sort_fields(parent);
                }
            }
            Ok(fields)
        }

        Op::MapDelete { path, key, .. } => {
            let (parent, last_comp) = navigate_mut(&mut fields, path)?;
            if let Some(PathComp::Field(n)) = last_comp {
                if let Some(idx) = find_field(parent, *n) {
                    match &mut parent[idx].value {
                        FieldValue::Map { entries, .. } => {
                            if let Some(ei) = entries.iter().position(|(k, _)| k == key) {
                                entries.remove(ei);
                            }
                        }
                        _ => return Err(format!("field {n} is not a map")),
                    }
                }
            }
            Ok(fields)
        }

        Op::OneofSwitch { path, active_field, value_type, value } => {
            let (parent, last_comp) = navigate_mut(&mut fields, path)?;
            if let Some(PathComp::Field(n)) = last_comp {
                let new_field = Field {
                    num: *n,
                    value: FieldValue::Oneof {
                        active_field: *active_field,
                        value_type: *value_type,
                        value: value.clone(),
                    },
                };
                if let Some(idx) = find_field(parent, *n) {
                    parent[idx] = new_field;
                } else {
                    parent.push(new_field);
                    sort_fields(parent);
                }
            }
            Ok(fields)
        }
    }
}

pub fn apply_chain(mut fields: Vec<Field>, ops: &[Op]) -> Result<Vec<Field>, String> {
    for op in ops {
        fields = apply_op(fields, op)?;
    }
    Ok(fields)
}
