import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_STORAGE, MAX_MONTH, mayPost, mayView, reserveBytes, validateMedia } from '../src/domain.ts'

test('posting and family scope matrix', () => {
  const roles = [
    [null, false, []],
    [{ role: 'parent' }, true, ['parents', 'all', 'paternal', 'maternal']],
    [{ role: 'admin' }, true, ['parents', 'all', 'paternal', 'maternal']],
    [{ role: 'grandparent', side: 'paternal' }, false, ['all', 'paternal']],
    [{ role: 'grandparent', side: 'maternal' }, false, ['all', 'maternal']],
    [{ role: 'grandparent' }, false, ['all']],
    [{ role: 'unknown' }, false, []],
  ] as const
  for (const [member, posting, scopes] of roles) {
    assert.equal(mayPost(member as never), posting)
    assert.deepEqual(['parents', 'all', 'paternal', 'maternal', 'bad'].filter(scope =>
      mayView(member as never, scope as never)), scopes)
  }
})

test('quota boundaries and corrupt counters are refused', () => {
  assert.deepEqual(reserveBytes(MAX_STORAGE - 1, MAX_MONTH - 1, 1), { total: MAX_STORAGE, month: MAX_MONTH })
  assert.throws(() => reserveBytes(MAX_STORAGE, 0, 1),
    { status: 413, message: 'family total storage quota exceeded' })
  assert.throws(() => reserveBytes(0, MAX_MONTH, 1),
    { status: 413, message: 'family monthly upload quota exceeded' })
  const exact = reserveBytes(4_999_987_641, 37_077, 12_359)
  assert.deepEqual(exact, { total: 5_000_000_000, month: 49_436 })
  assert.throws(() => reserveBytes(exact.total, exact.month, 12_359),
    { status: 413, message: 'family total storage quota exceeded' })
  assert.throws(() => reserveBytes(NaN, 0, 1), { status: 400 })
  assert.throws(() => reserveBytes(0, 0, 0), { status: 400 })
})

function mp4(duration: number, mediaSize: 'normal' | 'extended' | 'to-end' = 'normal') {
  const head = Buffer.alloc(20)
  head.writeUInt32BE(1000, 12)
  head.writeUInt32BE(duration, 16)
  function box(name: string, body: Buffer, size: typeof mediaSize = 'normal') {
    const header = Buffer.alloc(size === 'extended' ? 16 : 8)
    const length = header.length + body.length
    header.writeUInt32BE(size === 'extended' ? 1 : size === 'to-end' ? 0 : length)
    if (size === 'extended') header.writeBigUInt64BE(BigInt(length), 8)
    header.write(name, 4, 'ascii')
    return Buffer.concat([header, body])
  }
  const fileType = box('ftyp', Buffer.from('isom'))
  const movie = box('moov', box('mvhd', head))
  const media = box('mdat', Buffer.from([0]), mediaSize)
  // Android may write an extended mdat before the movie metadata.
  return Uint8Array.from(Buffer.concat(mediaSize === 'extended'
    ? [fileType, media, movie]
    : [fileType, movie, media])).buffer
}

test('JPEG/MP4 envelopes and duration cut-off', () => {
  assert.doesNotThrow(() => validateMedia(new Uint8Array([255, 216, 255, 217]).buffer, 'image/jpeg'))
  assert.throws(() => validateMedia(new ArrayBuffer(4), 'image/jpeg'), { status: 422 })
  assert.doesNotThrow(() => validateMedia(mp4(60_000), 'video/mp4'))
  assert.throws(() => validateMedia(mp4(60_001), 'video/mp4'), { status: 422 })
  assert.throws(() => validateMedia(mp4(0), 'video/mp4'), { status: 422 })
  assert.throws(() => validateMedia(mp4(1000).slice(0, -1), 'video/mp4'), { status: 422 })
})

test('accepts Android-style extended mdat and still enforces duration and box bounds', () => {
  assert.doesNotThrow(() => validateMedia(mp4(5000, 'extended'), 'video/mp4'))
  assert.doesNotThrow(() => validateMedia(mp4(60000, 'to-end'), 'video/mp4'))
  assert.throws(() => validateMedia(mp4(60001, 'extended'), 'video/mp4'), { status: 422 })
  const file = mp4(5000, 'extended')
  assert.throws(() => validateMedia(file.slice(0, 24), 'video/mp4'), { status: 422 })
  for (const invalidSize of [15n, 1n << 63n]) {
    new DataView(file).setBigUint64(20, invalidSize)
    assert.throws(() => validateMedia(file, 'video/mp4'), { status: 422 })
  }
})

test('publishing MP4 clears standard metadata without moving media offsets', () => {
  const clip = new Uint8Array(mp4(2000))
  const location = Buffer.from('private location metadata')
  const extra = Buffer.alloc(8 + location.length)
  extra.writeUInt32BE(extra.length)
  extra.write('udta', 4, 'ascii')
  location.copy(extra, 8)
  const full = Uint8Array.from(Buffer.concat([clip, extra]))
  validateMedia(full.buffer, 'video/mp4', true)
  assert.deepEqual(full.subarray(0, clip.length), clip)
  assert.equal(Buffer.from(full.subarray(clip.length + 4, clip.length + 8)).toString(), 'free')
  assert.ok(full.subarray(clip.length + 8).every(byte => byte === 0))
  assert.doesNotThrow(() => validateMedia(full.buffer, 'video/mp4'))
})
