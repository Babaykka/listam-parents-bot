'use strict';

async function collectPaginated(options) {
  const {
    fetchPage,
    identify = (item) => item.id || item.canonical_url,
    maxPages = 5,
    maxRecords = 500,
    resumeCursor = null,
    onCheckpoint = async () => {},
  } = options;
  const records = [];
  const seen = new Set();
  const visitedCursors = new Set();
  let cursor = resumeCursor;
  let pageNumber = 0;
  let consecutiveEmpty = 0;
  let stopReason = 'source_exhausted';

  while (pageNumber < maxPages && records.length < maxRecords) {
    const cursorKey = cursor === null ? '__first__' : JSON.stringify(cursor);
    if (visitedCursors.has(cursorKey)) {
      stopReason = 'pagination_cycle';
      break;
    }
    visitedCursors.add(cursorKey);
    const page = await fetchPage({ cursor, pageNumber });
    pageNumber += 1;
    let added = 0;
    for (const item of page.items || []) {
      const identity = identify(item);
      if (!identity || seen.has(identity)) continue;
      seen.add(identity);
      records.push(item);
      added += 1;
      if (records.length >= maxRecords) break;
    }
    consecutiveEmpty = added === 0 ? consecutiveEmpty + 1 : 0;
    cursor = page.nextCursor ?? null;
    await onCheckpoint({ cursor, pageNumber, recordsSeen: records.length, consecutiveEmpty });
    if (consecutiveEmpty >= 3) {
      stopReason = 'three_empty_pages';
      break;
    }
    if (cursor === null) break;
  }
  if (records.length >= maxRecords) stopReason = 'record_limit';
  else if (pageNumber >= maxPages && cursor !== null) stopReason = 'page_limit';
  return { records, cursor, pageNumber, stopReason };
}

module.exports = { collectPaginated };
