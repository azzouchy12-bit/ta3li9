const { chromium } = require("playwright");

const DEFAULT_MAX_IDLE_LOOPS = 6;
const REPLY_TEXT_PATTERN = /\b(reply|رد|répondre|responder|rispondi|antworten)\b/i;
const LOAD_MORE_PATTERN = /(view( more)? comments|see more comments|عرض المزيد|المزيد من التعليقات|plus de commentaires|ver mas comentarios|mostra altri commenti)/i;

async function connectBrowser(log) {
  const cdpUrl = process.env.CHROME_CDP_URL;
  if (cdpUrl) {
    log(`Connecting to Chrome via CDP: ${cdpUrl}`);
    const browser = await chromium.connectOverCDP(cdpUrl);
    return { browser, mode: "cdp" };
  }

  const headless = process.env.HEADLESS !== "false";
  log(`Launching isolated Chromium (headless=${headless})`);

  const browser = await chromium.launch({
    headless,
    args: ["--disable-dev-shm-usage", "--no-sandbox"]
  });
  return { browser, mode: "isolated" };
}

async function getOrCreatePage(browser, mode) {
  if (mode === "cdp") {
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = context.pages()[0] || (await context.newPage());
    return { context, page };
  }

  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 }
  });
  const page = await context.newPage();
  return { context, page };
}

async function assertLoggedIn(page) {
  const url = page.url();
  if (/\/login|checkpoint/i.test(url)) {
    throw new Error(
      "Facebook is asking for login/checkpoint. Open Facebook in the same Chrome profile first, then retry."
    );
  }

  const emailInputExists = (await page.locator('input[name="email"]').count()) > 0;
  if (emailInputExists) {
    throw new Error(
      "Facebook login page detected. The bot needs an already logged-in browser session."
    );
  }
}

async function clickLoadMoreButtons(page) {
  const buttons = await page.$$("div[role='button'], span[role='button']");
  for (const button of buttons) {
    const text = await button.evaluate(
      (el) => (el.innerText || el.textContent || "").trim().toLowerCase()
    );
    if (!text || !LOAD_MORE_PATTERN.test(text)) {
      continue;
    }
    try {
      await button.scrollIntoViewIfNeeded();
      await button.click({ timeout: 1200 });
      await page.waitForTimeout(250);
    } catch {
      // Ignore load-more clicks that fail and continue with other buttons.
    }
  }
}

async function getReplyButtons(page) {
  const buttons = await page.$$("div[role='button'], span[role='button']");
  const matches = [];

  for (const button of buttons) {
    const text = await button.evaluate(
      (el) => (el.innerText || el.textContent || "").trim().toLowerCase()
    );
    if (!text || text.length > 35) {
      continue;
    }
    if (REPLY_TEXT_PATTERN.test(text)) {
      matches.push(button);
    }
  }

  return matches;
}

async function getCommentKey(button) {
  return button.evaluate((el) => {
    const container =
      el.closest("[data-commentid]") ||
      el.closest("[id]") ||
      el.closest("div[role='article']") ||
      el.parentElement;

    if (!container) {
      return null;
    }

    const explicitId =
      container.getAttribute("data-commentid") ||
      container.getAttribute("id") ||
      container.getAttribute("data-testid");

    if (explicitId) {
      return explicitId;
    }

    const text = (container.textContent || "").replace(/\s+/g, " ").trim();
    return text.slice(0, 240) || null;
  });
}

async function sendReply(page, button, replyText, delayMs) {
  try {
    await button.scrollIntoViewIfNeeded();
    await button.click({ timeout: 2500 });
    await page.waitForTimeout(350);

    const replyBox = page.locator("div[role='textbox'][contenteditable='true']").last();
    await replyBox.waitFor({ state: "visible", timeout: 2500 });
    await replyBox.click({ timeout: 2500 });
    await replyBox.fill(replyText);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(delayMs);
    return true;
  } catch {
    return false;
  }
}

async function runAutoReply({ postUrl, replies, maxComments, delayMs, log }) {
  const processedKeys = new Set();
  let repliedCount = 0;
  let scannedCandidates = 0;

  const { browser, mode } = await connectBrowser(log);
  let context = null;

  try {
    const result = await getOrCreatePage(browser, mode);
    context = result.context;
    const { page } = result;

    log(`Opening post URL: ${postUrl}`);
    await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(3000);
    await assertLoggedIn(page);

    let idleLoops = 0;

    while (repliedCount < maxComments && idleLoops < DEFAULT_MAX_IDLE_LOOPS) {
      await clickLoadMoreButtons(page);

      const replyButtons = await getReplyButtons(page);
      let repliedThisLoop = 0;

      for (const button of replyButtons) {
        if (repliedCount >= maxComments) {
          break;
        }

        const key = await getCommentKey(button);
        if (!key || processedKeys.has(key)) {
          continue;
        }

        processedKeys.add(key);
        scannedCandidates += 1;

        const replyText = replies[repliedCount % replies.length];
        const ok = await sendReply(page, button, replyText, delayMs);
        if (ok) {
          repliedCount += 1;
          repliedThisLoop += 1;
          log(`Replied to comment #${repliedCount}`);
        }
      }

      if (repliedThisLoop === 0) {
        idleLoops += 1;
      } else {
        idleLoops = 0;
      }

      await page.mouse.wheel(0, 2400);
      await page.waitForTimeout(1200);
    }

    return {
      mode,
      repliedCount,
      scannedCandidates,
      stoppedReason:
        repliedCount >= maxComments ? "maxComments_reached" : "no_new_comments_detected"
    };
  } finally {
    if (mode === "isolated") {
      if (context) {
        await context.close().catch(() => {});
      }
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  runAutoReply
};
