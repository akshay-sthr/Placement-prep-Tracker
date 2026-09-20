const express = require("express");
const path = require("path");
const mongoose = require("mongoose");
const lib = require("./lib");

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- MongoDB ----------
// Local:  mongodb://127.0.0.1:27017/placement-tracker
// Atlas:  set MONGODB_URI to your connection string
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/placement-tracker";
let dbError = null;

// If MongoDB isn't running yet, keep retrying so you can start it later
// without restarting this server.
async function connectWithRetry() {
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    dbError = null;
    console.log("MongoDB connected");
  } catch (err) {
    dbError = err.message;
    console.error(`MongoDB not reachable (${err.message}). Retrying in 5 seconds...`);
    setTimeout(connectWithRetry, 5000);
  }
}

const TOPICS = [
  "Arrays",
  "Strings",
  "Hashing",
  "Linked List",
  "Stack and Queue",
  "Recursion and Backtracking",
  "Sorting and Searching",
  "Trees",
  "Graphs",
  "Heap",
  "Greedy",
  "Dynamic Programming",
  "Bit Manipulation",
  "Math",
  "Other",
];
const DIFFICULTIES = ["Easy", "Medium", "Hard"];
const STATUSES = ["solved", "stuck"];
const MOCK_TYPES = ["DSA", "Technical", "System Design", "HR", "Aptitude", "Other"];

const problemSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    platform: { type: String, trim: true, default: "LeetCode", maxlength: 40 },
    url: { type: String, trim: true, default: "", maxlength: 500 },
    topic: { type: String, enum: TOPICS, default: "Other" },
    difficulty: { type: String, enum: DIFFICULTIES, default: "Medium" },
    status: { type: String, enum: STATUSES, default: "solved" },
    solvedDate: { type: String, required: true }, // "YYYY-MM-DD"
    notes: { type: String, default: "", maxlength: 2000 },
    // spaced repetition
    reviewStage: { type: Number, default: 0 },
    nextReview: { type: String, default: null }, // null = mastered
    lastReviewed: { type: String, default: null },
  },
  { timestamps: true }
);
const Problem = mongoose.model("Problem", problemSchema);

const mockSchema = new mongoose.Schema(
  {
    date: { type: String, required: true },
    type: { type: String, enum: MOCK_TYPES, default: "DSA" },
    company: { type: String, trim: true, default: "", maxlength: 80 },
    rating: { type: Number, required: true, min: 1, max: 5 },
    notes: { type: String, default: "", maxlength: 3000 },
  },
  { timestamps: true }
);
const Mock = mongoose.model("Mock", mockSchema);

// ---------- Helpers ----------
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    if (err.name === "ValidationError" || err.name === "CastError") {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  });

const pick = (obj, keys) => {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PROBLEM_FIELDS = ["title", "platform", "url", "topic", "difficulty", "status", "solvedDate", "notes"];
const MOCK_FIELDS = ["date", "type", "company", "rating", "notes"];

// Fail fast with a clear message instead of letting requests hang
app.use("/api", (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      error: "The database isn't connected. Start MongoDB and this page will reconnect on its own.",
      detail: dbError,
    });
  }
  next();
});

// ---------- Problems ----------
app.get("/api/problems", wrap(async (req, res) => {
  const { q, topic, difficulty, status } = req.query;
  const filter = {};
  if (typeof q === "string" && q.trim()) filter.title = { $regex: escapeRegex(q.trim()), $options: "i" };
  if (TOPICS.includes(topic)) filter.topic = topic;
  if (DIFFICULTIES.includes(difficulty)) filter.difficulty = difficulty;
  if (STATUSES.includes(status)) filter.status = status;

  const problems = await Problem.find(filter).sort({ solvedDate: -1, createdAt: -1 }).limit(500).lean();
  res.json(problems);
}));

app.post("/api/problems", wrap(async (req, res) => {
  const data = pick(req.body, PROBLEM_FIELDS);
  if (!lib.isDateStr(data.solvedDate)) data.solvedDate = lib.todayOr(req.query.today);
  data.reviewStage = 0;
  data.nextReview = lib.nextReviewFor(0, data.solvedDate);
  const problem = await Problem.create(data);
  res.status(201).json(problem);
}));

app.put("/api/problems/:id", wrap(async (req, res) => {
  const data = pick(req.body, PROBLEM_FIELDS);
  if (data.solvedDate !== undefined && !lib.isDateStr(data.solvedDate)) delete data.solvedDate;
  const problem = await Problem.findByIdAndUpdate(req.params.id, data, { new: true, runValidators: true });
  if (!problem) return res.status(404).json({ error: "Problem not found." });
  res.json(problem);
}));

app.delete("/api/problems/:id", wrap(async (req, res) => {
  const problem = await Problem.findByIdAndDelete(req.params.id);
  if (!problem) return res.status(404).json({ error: "Problem not found." });
  res.json({ ok: true });
}));

// ---------- Spaced repetition ----------
app.get("/api/reviews/due", wrap(async (req, res) => {
  const today = lib.todayOr(req.query.today);
  const due = await Problem.find({ nextReview: { $ne: null, $lte: today } }).sort({ nextReview: 1 }).lean();
  res.json(due);
}));

app.post("/api/problems/:id/review", wrap(async (req, res) => {
  const today = lib.todayOr(req.query.today);
  const problem = await Problem.findById(req.params.id);
  if (!problem) return res.status(404).json({ error: "Problem not found." });

  if (req.body && req.body.remembered) {
    problem.reviewStage += 1;
    problem.nextReview = lib.nextReviewFor(problem.reviewStage, today);
  } else {
    problem.reviewStage = 0;
    problem.nextReview = lib.addDays(today, lib.INTERVALS[0]);
  }
  problem.lastReviewed = today;
  await problem.save();
  res.json(problem);
}));

// ---------- Stats for the dashboard ----------
app.get("/api/stats", wrap(async (req, res) => {
  const today = lib.todayOr(req.query.today);

  const [problems, mocks, recent] = await Promise.all([
    Problem.find({}, "topic difficulty status solvedDate nextReview").lean(),
    Mock.find({}, "rating").lean(),
    Problem.find().sort({ solvedDate: -1, createdAt: -1 }).limit(6).lean(),
  ]);

  const byDifficulty = { Easy: 0, Medium: 0, Hard: 0 };
  const topicCounts = {};
  const perDay = {};
  let stuck = 0;
  let mastered = 0;
  let dueCount = 0;

  for (const p of problems) {
    byDifficulty[p.difficulty] = (byDifficulty[p.difficulty] || 0) + 1;
    topicCounts[p.topic] = (topicCounts[p.topic] || 0) + 1;
    perDay[p.solvedDate] = (perDay[p.solvedDate] || 0) + 1;
    if (p.status === "stuck") stuck++;
    if (p.nextReview == null) mastered++;
    else if (p.nextReview <= today) dueCount++;
  }

  const days = [];
  for (let i = lib.HEATMAP_DAYS - 1; i >= 0; i--) {
    const date = lib.addDays(today, -i);
    days.push({ date, count: perDay[date] || 0 });
  }
  const last7 = days.slice(-7).reduce((sum, d) => sum + d.count, 0);

  const ratings = mocks.map((m) => m.rating);
  const avgMock = ratings.length
    ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
    : null;

  res.json({
    today,
    total: problems.length,
    stuck,
    mastered,
    dueCount,
    last7,
    byDifficulty,
    byTopic: Object.entries(topicCounts)
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count),
    streak: lib.computeStreaks(Object.keys(perDay), today),
    days,
    mockCount: mocks.length,
    avgMock,
    recent,
    reviewSteps: lib.INTERVALS.length,
  });
}));

// ---------- Mock interviews ----------
app.get("/api/mocks", wrap(async (req, res) => {
  const mocks = await Mock.find().sort({ date: -1, createdAt: -1 }).limit(200).lean();
  res.json(mocks);
}));

app.post("/api/mocks", wrap(async (req, res) => {
  const data = pick(req.body, MOCK_FIELDS);
  if (!lib.isDateStr(data.date)) data.date = lib.todayOr(req.query.today);
  data.rating = Number(data.rating);
  const mock = await Mock.create(data);
  res.status(201).json(mock);
}));

app.delete("/api/mocks/:id", wrap(async (req, res) => {
  const mock = await Mock.findByIdAndDelete(req.params.id);
  if (!mock) return res.status(404).json({ error: "Mock interview not found." });
  res.json({ ok: true });
}));

// ---------- Sample data (only when the database is empty) ----------
app.post("/api/seed", wrap(async (req, res) => {
  const [pCount, mCount] = await Promise.all([Problem.countDocuments(), Mock.countDocuments()]);
  if (pCount > 0 || mCount > 0) {
    return res.status(409).json({ error: "Sample data can only be added to an empty tracker." });
  }
  const today = lib.todayOr(req.query.today);

  // [title, topic, difficulty, status, days ago, url]
  const samples = [
    ["Two Sum", "Hashing", "Easy", "solved", 0, "https://leetcode.com/problems/two-sum/"],
    ["Valid Parentheses", "Stack and Queue", "Easy", "solved", 0, "https://leetcode.com/problems/valid-parentheses/"],
    ["Reverse Linked List", "Linked List", "Easy", "solved", 1, "https://leetcode.com/problems/reverse-linked-list/"],
    ["Merge Intervals", "Arrays", "Medium", "solved", 2, "https://leetcode.com/problems/merge-intervals/"],
    ["Binary Tree Level Order Traversal", "Trees", "Medium", "solved", 2, "https://leetcode.com/problems/binary-tree-level-order-traversal/"],
    ["Number of Islands", "Graphs", "Medium", "solved", 3, "https://leetcode.com/problems/number-of-islands/"],
    ["Climbing Stairs", "Dynamic Programming", "Easy", "solved", 4, "https://leetcode.com/problems/climbing-stairs/"],
    ["Longest Substring Without Repeating Characters", "Strings", "Medium", "solved", 5, "https://leetcode.com/problems/longest-substring-without-repeating-characters/"],
    ["Coin Change", "Dynamic Programming", "Medium", "stuck", 6, "https://leetcode.com/problems/coin-change/"],
    ["Course Schedule", "Graphs", "Medium", "stuck", 8, "https://leetcode.com/problems/course-schedule/"],
    ["Kth Largest Element in an Array", "Heap", "Medium", "solved", 9, "https://leetcode.com/problems/kth-largest-element-in-an-array/"],
    ["Trapping Rain Water", "Arrays", "Hard", "stuck", 10, "https://leetcode.com/problems/trapping-rain-water/"],
    ["Group Anagrams", "Hashing", "Medium", "solved", 12, "https://leetcode.com/problems/group-anagrams/"],
    ["Binary Search", "Sorting and Searching", "Easy", "solved", 13, "https://leetcode.com/problems/binary-search/"],
  ];

  const docs = samples.map(([title, topic, difficulty, status, ago, url]) => {
    const solvedDate = lib.addDays(today, -ago);
    // Spread the review stages so the demo shows a mix of due and upcoming reviews
    const stage = ago <= 1 ? 0 : ago <= 5 ? 1 : 2;
    const lastReviewed = stage === 0 ? null : lib.addDays(solvedDate, 1);
    const nextReview = stage === 0 ? lib.addDays(solvedDate, 1) : lib.addDays(solvedDate, stage === 1 ? 4 : 11);
    return {
      title,
      topic,
      difficulty,
      status,
      url,
      platform: "LeetCode",
      solvedDate,
      notes: status === "stuck" ? "Needed a hint. Redo without looking at the solution." : "",
      reviewStage: stage,
      nextReview,
      lastReviewed,
    };
  });
  await Problem.insertMany(docs);

  await Mock.insertMany([
    {
      date: lib.addDays(today, -9),
      type: "DSA",
      company: "Practice with a friend",
      rating: 3,
      notes: "Solved the array question but ran out of time on the follow-up. Explain the approach before coding.",
    },
    {
      date: lib.addDays(today, -2),
      type: "Technical",
      company: "College placement cell",
      rating: 4,
      notes: "Good answers on OOP and SQL joins. Revise indexing and normalization.",
    },
  ]);

  res.status(201).json({ ok: true, problems: docs.length, mocks: 2 });
}));

// ---------- Errors ----------
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON." });
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Placement tracker running at http://localhost:${PORT}`);
  connectWithRetry();
});
