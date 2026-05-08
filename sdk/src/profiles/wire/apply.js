// weavepack-wire — delta application (applyChain, applyOp).
//
// Operates on decoded field arrays (the same representation that
// decodeDocument/encodeDocument use). No byte-level work here.
//
// Profile isolation: imports only from ./types.js.

import { OP, VTYPE } from "./types.js"

// ── Path navigation helpers ────────────────────────────────────────────────

// Deep-clone a field array (needed for immutable apply).
function cloneFields(fields) {
  return fields.map(f => {
    if (f.message !== undefined) return { ...f, message: cloneFields(f.message) }
    if (f.repeated !== undefined) return { ...f, repeated: { ...f.repeated, values: [...f.repeated.values] } }
    if (f.map !== undefined) return { ...f, map: { ...f.map, entries: [...f.map.entries.map(e => [...e])] } }
    if (f.oneof !== undefined) return { ...f, oneof: { ...f.oneof } }
    return { ...f }
  })
}

function findField(fields, num) {
  return fields.findIndex(f => f.num === num)
}

// Navigate a path against a field list, returning a reference chain
// suitable for mutation. Returns { parent, parentKey, target } or null.
//
// path: [{field}, {map}, {index}, ...] ending (implicitly) at the target.
// We apply on mutable fields in place (caller clones first).
function navigate(fields, path) {
  // Walk all components except the last, arriving at the parent container.
  // The last component identifies what to operate on.
  // Returns { parentFields, lastComp } for mutations.
  if (path.length === 0) return { parentFields: null, lastComp: null, fields }

  let current = fields
  for (let i = 0; i < path.length - 1; i++) {
    const comp = path[i]
    if (comp.field !== undefined) {
      const idx = findField(current, comp.field)
      if (idx === -1) throw new Error(`field ${comp.field} not found`)
      const f = current[idx]
      if (f.message !== undefined) { current = f.message; continue }
      throw new Error(`field ${comp.field} is not a message`)
    }
    if (comp.index !== undefined) {
      // current must be a repeated field's values — but we need the field itself
      // This case arises when navigating into a repeated message.
      // Not supported in v0.1 (scalar-only repeated).
      throw new Error("nested repeated navigation not supported in v0.1")
    }
    throw new Error(`unexpected mid-path component type`)
  }
  return { parentFields: current, lastComp: path[path.length - 1] }
}

// ── Op application ─────────────────────────────────────────────────────────

function applyOp(fields, op) {
  // Clone for immutability.
  fields = cloneFields(fields)

  const path = op.path ?? []

  if (op.op === OP.MESSAGE_REPLACE) {
    if (path.length === 0) {
      // Replace root.
      return cloneFields(op.message)
    }
    const { parentFields, lastComp } = navigate(fields, path)
    if (lastComp.field !== undefined) {
      const idx = findField(parentFields, lastComp.field)
      const replacement = { num: lastComp.field, message: cloneFields(op.message) }
      if (idx === -1) parentFields.push(replacement)
      else parentFields[idx] = replacement
      parentFields.sort((a, b) => a.num - b.num)
    }
    return fields
  }

  if (op.op === OP.FIELD_SET) {
    const { parentFields, lastComp } = navigate(fields, path)
    if (lastComp.field !== undefined) {
      const idx = findField(parentFields, lastComp.field)
      let newField
      if (op.value.message !== undefined) {
        newField = { num: lastComp.field, message: cloneFields(op.value.message) }
      } else {
        newField = { num: lastComp.field, vtype: op.value.vtype, value: op.value.value }
      }
      if (idx === -1) parentFields.push(newField)
      else parentFields[idx] = newField
      parentFields.sort((a, b) => a.num - b.num)
    }
    return fields
  }

  if (op.op === OP.FIELD_DELETE) {
    const { parentFields, lastComp } = navigate(fields, path)
    if (lastComp.field !== undefined) {
      const idx = findField(parentFields, lastComp.field)
      if (idx !== -1) parentFields.splice(idx, 1)
    }
    return fields
  }

  if (op.op === OP.REPEATED_APPEND) {
    const { parentFields, lastComp } = navigate(fields, path)
    if (lastComp.field !== undefined) {
      const idx = findField(parentFields, lastComp.field)
      if (idx === -1) {
        parentFields.push({
          num: lastComp.field,
          repeated: { elemType: op.elements.elemType, values: [...op.elements.values] },
        })
        parentFields.sort((a, b) => a.num - b.num)
      } else {
        const f = parentFields[idx]
        if (f.repeated === undefined) throw new Error(`field ${lastComp.field} is not repeated`)
        f.repeated.values.push(...op.elements.values)
      }
    }
    return fields
  }

  if (op.op === OP.REPEATED_SPLICE) {
    const { parentFields, lastComp } = navigate(fields, path)
    if (lastComp.field !== undefined) {
      const idx = findField(parentFields, lastComp.field)
      if (idx === -1) throw new Error(`repeated field ${lastComp.field} not found`)
      const f = parentFields[idx]
      if (f.repeated === undefined) throw new Error(`field ${lastComp.field} is not repeated`)
      f.repeated.values.splice(op.index, op.deleteCount, ...op.insertValues)
    }
    return fields
  }

  if (op.op === OP.MAP_SET) {
    const { parentFields, lastComp } = navigate(fields, path)
    if (lastComp.field !== undefined) {
      const idx = findField(parentFields, lastComp.field)
      if (idx === -1) {
        parentFields.push({
          num: lastComp.field,
          map: { keyType: op.keyType, valueType: op.valueType, entries: [[op.key, op.value]] },
        })
        parentFields.sort((a, b) => a.num - b.num)
      } else {
        const f = parentFields[idx]
        if (f.map === undefined) throw new Error(`field ${lastComp.field} is not a map`)
        const ei = f.map.entries.findIndex(([k]) => k === op.key)
        if (ei === -1) f.map.entries.push([op.key, op.value])
        else f.map.entries[ei][1] = op.value
      }
    }
    return fields
  }

  if (op.op === OP.MAP_DELETE) {
    const { parentFields, lastComp } = navigate(fields, path)
    if (lastComp.field !== undefined) {
      const idx = findField(parentFields, lastComp.field)
      if (idx !== -1) {
        const f = parentFields[idx]
        if (f.map === undefined) throw new Error(`field ${lastComp.field} is not a map`)
        const ei = f.map.entries.findIndex(([k]) => k === op.key)
        if (ei !== -1) f.map.entries.splice(ei, 1)
      }
    }
    return fields
  }

  if (op.op === OP.ONEOF_SWITCH) {
    const { parentFields, lastComp } = navigate(fields, path)
    if (lastComp.field !== undefined) {
      const idx = findField(parentFields, lastComp.field)
      const newOneof = {
        num: lastComp.field,
        oneof: { activeField: op.activeField, valueType: op.valueType, value: op.value },
      }
      if (idx === -1) { parentFields.push(newOneof); parentFields.sort((a, b) => a.num - b.num) }
      else parentFields[idx] = newOneof
    }
    return fields
  }

  throw new Error(`unknown op ${op.op}`)
}

export function applyChain(fields, ops) {
  let state = fields
  for (const op of ops) state = applyOp(state, op)
  return state
}
