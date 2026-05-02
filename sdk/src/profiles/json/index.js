import { Encoder } from "../../encoder.js"
import { encode } from "./encode.js"
import { Decoder } from "./decoder.js"
import { ARTable } from "../../artable.js"
import { equals, isObject } from "../../utils.js"
import { encodeFastDiff } from "./strdiff.js"
import { diff, isNonStructural } from "./diff.js"

// Shared singletons reused across calls to avoid Uint32Array reallocation
// per call. Both `encode()` and `decode()` reset internal state at entry,
// and JS's single-threaded execution model means a sync call can't be
// interrupted by another sync call. Async/concurrent callers that want
// isolation can construct their own Encoder/Decoder.
const _sharedEnc = new Encoder()
const _sharedDec = new Decoder()
export const enc = json => encode(json, _sharedEnc)
export const dec = arj => {
  _sharedDec.decode(arj)
  return _sharedDec.json
}

export class ARJSON {
  constructor({ json, arj, table }) {
    this.buflen = 0
    const d = new Decoder()
    if (table) {
      this.artable = new ARTable(table)
      this.json = this.artable.build()
      this.deltas = []
    } else if (arj) {
      this.deltas = ARJSON.fromBuffer(arj)
      d.decode(this.deltas[0])
      const table = d.table()
      if (d.single) table.single = d.json
      this.artable = new ARTable(table)
      this.json = d.single ? d.json : this.artable.build()
      if (this.deltas.length > 0) {
        for (const v of this.deltas.slice(1)) {
          ;({ json } = this.artable.update(v))
          this.json = json
        }
      }
    } else {
      this.json = json
      arj = enc(json)
      d.decode(arj)
      const table = d.table()
      if (d.single) table.single = d.json
      this.artable = new ARTable(table)
      this.deltas = [arj]
    }
  }
  table() {
    return this.artable.table()
  }
  update(json) {
    if (isNonStructural(this.json) && !equals(this.json, json)) {
      return this.reanchor(json)
    }
    let deltas = []
    const diffs = diff(this.json, json)
    for (const v of diffs) {
      let _diff =
        v.op === "diff" ? encodeFastDiff(v.diffs, this.artable.strmap) : null
      if (v.path === "") {
        return this.reanchor(json)
      }
      if (
        v.op === "replace" &&
        isObject(v.to) &&
        v.to !== null
      ) {
        return this.reanchor(json)
      }
      const delta = this.load(
        this.artable.delta(v.path, v.to, v.op, 1, _diff).delta,
      )
      deltas.push(delta)
    }
    return deltas
  }

  reanchor(json) {
    const fresh = enc(json)
    const d = new Decoder()
    d.decode(fresh)
    const table = d.table()
    if (d.single) table.single = d.json
    this.artable = new ARTable(table)
    this.json = d.json
    this.deltas = [fresh]
    this.buflen = 0
    delete this.cache
    return [fresh]
  }
  load(delta) {
    this.json = this.artable.update(delta).json
    this.deltas.push(delta)
    delete this.cache
    return delta
  }
  static fromBuffer(buffer) {
    const buf = new Uint8Array(buffer)
    let offset = 0
    const deltas = []

    while (offset < buf.length) {
      let len = 0
      let shift = 0
      let byte
      do {
        byte = buf[offset++]
        len += (byte & 0x7f) * Math.pow(2, shift)
        shift += 7
      } while (byte & 0x80)

      const delta = buf.slice(offset, offset + len)
      deltas.push(delta)
      offset += len
    }

    return deltas
  }
  static toBuffer(deltas) {
    let totalSize = 0
    const lenBytesArray = []

    for (const delta of deltas) {
      const lenBytes = []
      let len = delta.length
      while (len >= 128) {
        lenBytes.push((len & 0x7f) | 0x80)
        len = Math.floor(len / 128)
      }
      lenBytes.push(len)
      lenBytesArray.push(lenBytes)
      totalSize += lenBytes.length + delta.length
    }

    const buffer = Buffer.allocUnsafe(totalSize)
    let offset = 0

    for (let i = 0; i < deltas.length; i++) {
      for (const byte of lenBytesArray[i]) buffer[offset++] = byte
      buffer.set(deltas[i], offset)
      offset += deltas[i].length
    }

    return buffer
  }
  toBuffer() {
    if (this.buflen !== this.deltas.length) {
      this.cache = ARJSON.toBuffer(this.deltas)
      this.buflen = this.deltas.length
    }
    return this.cache
  }
}

