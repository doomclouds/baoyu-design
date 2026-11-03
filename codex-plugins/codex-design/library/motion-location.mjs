/** Decode the player's authored-time anchor without changing recut semantics. */
export function motionCommentLocation(anchor) {
  if (typeof anchor !== 'string' || anchor.length > 1024) return null;
  const match = /^animation-v1:nth-of-type\(1\) > at-(\d{1,9})ms:nth-of-type\(1\) > (?:to-(\d{1,9})ms:nth-of-type\(1\)|x(\d{4})-y(\d{4}):nth-of-type\(1\)(?: > w(\d{4})-h(\d{4}):nth-of-type\(1\))?)$/.exec(anchor);
  if (!match) return null;
  const [, start, end, x, y, width, height] = match;
  const values = [start, x, y, end, width, height].filter(value => value !== undefined).map(Number);
  if (values.some(value => !Number.isSafeInteger(value)) || end !== undefined && Number(end) - Number(start) < 200) return null;
  return { file: 'db/film/script.json', anchor, coordinateSpace: 'authored', time: Number(start) / 1000,
    ...(x === undefined ? {} : { x: Number(x) / 10000, y: Number(y) / 10000 }),
    ...(end === undefined ? {} : { timeEnd: Number(end) / 1000 }),
    ...(width === undefined ? {} : { width: Math.min(1 - Number(x) / 10000, Number(width) / 10000), height: Math.min(1 - Number(y) / 10000, Number(height) / 10000) }) };
}
