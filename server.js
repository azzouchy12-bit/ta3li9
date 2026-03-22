require("dotenv").config();

const express = require("express");
const path = require("path");
const session = require("express-session");
const { runAutoReply } = require("./src/facebookBot");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const APP_PASSWORD = process.env.APP_PASSWORD || "5598";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret";

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 12
    }
  })
);

let runInProgress = false;

function requireAuth(req, res, next) {
  if (req.session?.authenticated) {
    return next();
  }
  return res.redirect("/login");
}

function defaultFormData() {
  return {
    postUrl: "",
    repliesText: "",
    maxComments: 200,
    delayMs: 1200
  };
}

app.get("/login", (req, res) => {
  if (req.session?.authenticated) {
    return res.redirect("/");
  }
  return res.render("login", { error: null });
});

app.post("/login", (req, res) => {
  const { password } = req.body;
  if (password === APP_PASSWORD) {
    req.session.authenticated = true;
    return res.redirect("/");
  }
  return res.status(401).render("login", { error: "Wrong password." });
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.get("/", requireAuth, (req, res) => {
  return res.render("index", {
    formData: defaultFormData(),
    result: null,
    error: null
  });
});

app.post("/run", requireAuth, async (req, res) => {
  const formData = {
    postUrl: (req.body.postUrl || "").trim(),
    repliesText: req.body.repliesText || "",
    maxComments: Number(req.body.maxComments || 200),
    delayMs: Number(req.body.delayMs || 1200)
  };

  const replies = formData.repliesText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!formData.postUrl) {
    return res.status(400).render("index", {
      formData,
      result: null,
      error: "Post URL is required."
    });
  }

  if (replies.length === 0) {
    return res.status(400).render("index", {
      formData,
      result: null,
      error: "Add at least one reply line."
    });
  }

  if (!Number.isFinite(formData.maxComments) || formData.maxComments < 1) {
    return res.status(400).render("index", {
      formData,
      result: null,
      error: "maxComments must be a number greater than 0."
    });
  }

  if (!Number.isFinite(formData.delayMs) || formData.delayMs < 0) {
    return res.status(400).render("index", {
      formData,
      result: null,
      error: "delayMs must be 0 or greater."
    });
  }

  if (runInProgress) {
    return res.status(409).render("index", {
      formData,
      result: null,
      error: "Another run is still in progress. Wait until it finishes."
    });
  }

  runInProgress = true;
  const logs = [];
  const log = (message) => {
    const timestamp = new Date().toISOString();
    logs.push(`[${timestamp}] ${message}`);
  };

  try {
    const result = await runAutoReply({
      postUrl: formData.postUrl,
      replies,
      maxComments: formData.maxComments,
      delayMs: formData.delayMs,
      log
    });

    return res.render("index", {
      formData,
      result: {
        ...result,
        logs
      },
      error: null
    });
  } catch (error) {
    log(`Run failed: ${error.message}`);
    return res.status(500).render("index", {
      formData,
      result: {
        mode: "failed",
        repliedCount: 0,
        scannedCandidates: 0,
        stoppedReason: "error",
        logs
      },
      error: error.message
    });
  } finally {
    runInProgress = false;
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on http://localhost:${PORT}`);
});
