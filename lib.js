// Pure helpers with no database code, so they are easy to test.
//
// All dates are plain "YYYY-MM-DD" strings taken from the user's own calendar.
// Working with strings (instead of Date objects) avoids timezone bugs like a
// problem solved at 11 pm showing up on the wrong day.

// Spaced repetition: after solving, review in 1 day. Each time you remember it,
// the gap grows: 3, 7, 14, 30, 60 days. After the last one the problem is "mastered".
// Forgetting sends it back to the start.
const INTERVALS = [1, 3, 7, 14, 30, 60];

// 34 weeks of activity for the heatmap
const HEATMAP_DAYS = 238;

const DAY_MS = 86400000;

function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function formatDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function isDateStr(s) {
  return (
    typeof s === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(parseDate(s)) &&
    formatDate(parseDate(s)) === s
  );
}

function addDays(s, n) {
  return formatDate(parseDate(s) + n * DAY_MS);
}

// Use the client's date if it is valid, otherwise fall back to the server's UTC date
function todayOr(s) {
  return isDateStr(s) ? s : formatDate(Date.now());
}

// dates: every day you logged at least one problem. today: "YYYY-MM-DD".
// The current streak stays alive if you practiced yesterday but not yet today.
function computeStreaks(dates, today) {
  const set = new Set(dates);

  let current = 0;
  let cursor = set.has(today) ? today : addDays(today, -1);
  while (set.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }

  let longest = 0;
  let run = 0;
  let prev = null;
  for (const d of [...set].sort()) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = d;
  }

  return { current, longest };
}

// stage = how many reviews in a row you have remembered.
// Returns the date of the next review, or null once the problem is mastered.
function nextReviewFor(stage, fromDate) {
  if (stage >= INTERVALS.length) return null;
  return addDays(fromDate, INTERVALS[stage]);
}

module.exports = {
  INTERVALS,
  HEATMAP_DAYS,
  isDateStr,
  addDays,
  todayOr,
  computeStreaks,
  nextReviewFor,
};
