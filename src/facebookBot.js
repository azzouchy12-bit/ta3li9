const { chromium } = require("playwright");

const DEFAULT_MAX_IDLE_LOOPS = 6;
const DEFAULT_MAX_FETCH_COMMENTS = Number(process.env.FETCH_MAX_COMMENTS || 1500);
const REPLY_TEXT_PATTERN = /\b(reply|رد|répondre|responder|rispondi|antworten)\b/i;
const LOAD_MORE_PATTERN = /(view( more)? comments|see more comments|عرض المزيد|المزيد من التعليقات|plus de commentaires|ver mas comentarios|mostra altri commenti)/i;
const CONTEXT_ERROR_PATTERN =
  /(Execution context was destroyed|Cannot find context with specified id|Target page, context or browser has been closed|page has been closed|most likely because of a navigation)/i;

function isTransientContextError(error) {
  return Boolean(error?.message && CONTEXT_ERROR_PATTERN.test(error.message));
}

function loadCookiesFromEnv(log) {
  const raw = process.env.FACEBOOK_COOKIES_JSON;
  if (!raw || !raw.trim()) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("FACEBOOK_COOKIES_JSON is not valid JSON.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("FACEBOOK_COOKIES_JSON must be a JSON array of cookies.");
  }

  const cookies = parsed
    .filter((cookie) => cookie && typeof cookie === "object")
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain || ".facebook.com",
      path: cookie.path || "/",
      httpOnly: Boolean(cookie.httpOnly),
      secure: cookie.secure !== false,
      sameSite: cookie.sameSite || "Lax",
      expires: typeof cookie.expires === "number" ? cookie.expires : -1
    }))
    .filter((cookie) => cookie.name && cookie.value && cookie.domain);

  log(`Loaded ${cookies.length} Facebook cookie(s) from env.`);
  return cookies;
}

async function connectBrowser(log) {
  const cdpUrl = process.env.CHROME_CDP_URL;
  if (cdpUrl) {
    log(`Connecting to Chrome via CDP: ${cdpUrl}`);
    const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 120000 });
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
    const contexts = browser.contexts();
    let selectedContext = contexts[0] || null;
    let selectedPage = null;

    // Prefer any existing Facebook tab across all CDP contexts.
    for (const ctx of contexts) {
      const pages = ctx.pages();
      const fbPage = pages.find((p) => /facebook\.com/i.test(p.url() || ""));
      if (fbPage) {
        selectedContext = ctx;
        selectedPage = fbPage;
        break;
      }
    }

    // Fallback: pick any existing non-empty context page (last page is usually the active tab).
    if (!selectedPage) {
      for (const ctx of contexts) {
        const pages = ctx.pages();
        if (pages.length > 0) {
          selectedContext = ctx;
          selectedPage = pages[pages.length - 1];
          break;
        }
      }
    }

    if (!selectedContext) {
      selectedContext = await browser.newContext();
    }

    if (!selectedPage) {
      throw new Error(
        "No open Chrome tab found for CDP. Open a Facebook tab in the debug Chrome window first, then retry."
      );
    }

    return { context: selectedContext, page: selectedPage };
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
    let text = "";
    try {
      text = await button.evaluate(
        (el) => (el.innerText || el.textContent || "").trim().toLowerCase()
      );
    } catch (error) {
      if (isTransientContextError(error)) {
        continue;
      }
      throw error;
    }

    if (!text || !LOAD_MORE_PATTERN.test(text)) {
      continue;
    }
    try {
      await button.scrollIntoViewIfNeeded();
      await button.click({ timeout: 1200 });
      await page.waitForTimeout(250);
    } catch (error) {
      if (isTransientContextError(error)) {
        continue;
      }
      // Ignore load-more clicks that fail and continue with other buttons.
    }
  }
}

async function getReplyButtons(page) {
  const buttons = await page.$$("div[role='button'], span[role='button']");
  const matches = [];

  for (const button of buttons) {
    let text = "";
    try {
      text = await button.evaluate(
        (el) => (el.innerText || el.textContent || "").trim().toLowerCase()
      );
    } catch (error) {
      if (isTransientContextError(error)) {
        continue;
      }
      throw error;
    }

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
  try {
    return await button.evaluate((el) => {
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
  } catch (error) {
    if (isTransientContextError(error)) {
      return null;
    }
    throw error;
  }
}

async function isReplyTextboxFocused(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active) {
      return false;
    }
    if (active.matches?.("div[role='textbox'][contenteditable='true']")) {
      return true;
    }
    return Boolean(active.closest?.("div[role='textbox'][contenteditable='true']"));
  });
}

async function findClosestVisibleTextbox(page, button) {
  const buttonBox = await button.boundingBox().catch(() => null);
  const textboxes = await page.$$("div[role='textbox'][contenteditable='true']");

  let bestTextbox = null;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestDistanceY = Number.POSITIVE_INFINITY;

  for (const textbox of textboxes) {
    try {
      const visible = await textbox.isVisible();
      if (!visible) {
        continue;
      }

      const textBoxRect = await textbox.boundingBox();
      if (!textBoxRect) {
        continue;
      }

      if (!buttonBox) {
        if (!bestTextbox) {
          bestTextbox = textbox;
        }
        continue;
      }

      const buttonCenterX = buttonBox.x + buttonBox.width / 2;
      const buttonCenterY = buttonBox.y + buttonBox.height / 2;
      const textCenterX = textBoxRect.x + textBoxRect.width / 2;
      const textCenterY = textBoxRect.y + textBoxRect.height / 2;

      const distanceX = Math.abs(textCenterX - buttonCenterX);
      const distanceY = Math.abs(textCenterY - buttonCenterY);
      const score = distanceY + distanceX * 0.35;

      if (score < bestScore) {
        bestScore = score;
        bestDistanceY = distanceY;
        bestTextbox = textbox;
      }
    } catch (error) {
      if (isTransientContextError(error)) {
        continue;
      }
      throw error;
    }
  }

  return { textbox: bestTextbox, distanceY: bestDistanceY };
}

async function sendReply(page, button, replyText, delayMs) {
  try {
    const buttonBox = await button.boundingBox().catch(() => null);
    await button.scrollIntoViewIfNeeded();
    await button.click({ timeout: 2500 });
    await page.waitForTimeout(500);

    let focused = await isReplyTextboxFocused(page).catch(() => false);
    let pickedReplyBox = null;

    if (!focused) {
      const closest = await findClosestVisibleTextbox(page, button);
      pickedReplyBox = closest.textbox;

      // Guard rail: skip if textbox is far away from clicked "Reply" button.
      if (buttonBox && Number.isFinite(closest.distanceY) && closest.distanceY > 360) {
        return false;
      }

      if (pickedReplyBox) {
        await pickedReplyBox.click({ timeout: 2500 });
        focused = await isReplyTextboxFocused(page).catch(() => false);
      }
    }

    if (!focused && !pickedReplyBox) {
      return false;
    }

    if (pickedReplyBox) {
      try {
        await pickedReplyBox.fill(replyText, { timeout: 2500 });
      } catch {
        await page.keyboard.type(replyText, { delay: 15 });
      }
    } else {
      await page.keyboard.type(replyText, { delay: 15 });
    }

    await page.keyboard.press("Enter");
    await page.waitForTimeout(delayMs);
    return true;
  } catch {
    return false;
  }
}

async function getCommentText(button) {
  try {
    return await button.evaluate((el) => {
      const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();

      const uiPattern =
        /^(like|reply|replies|share|edit|delete|view( more)? replies|see translation|most relevant|all comments|write a comment|comment|minutes?|hours?|days?|اعجاب|إعجاب|رد|الرد|ردود|عرض المزيد من الردود|عرض الترجمة|تعليق|تعليقات|حذف|تعديل)$/i;

      const container =
        el.closest("[data-commentid]") ||
        el.closest("div[role='article']") ||
        el.closest("li") ||
        el.parentElement;

      if (!container) {
        return "";
      }

      const lineNodes = container.querySelectorAll("div[dir='auto'], span[dir='auto']");
      const uniqueLines = [];
      const seen = new Set();

      for (const node of lineNodes) {
        const text = normalize(node.textContent);
        if (!text || text.length < 2 || text.length > 420) {
          continue;
        }
        if (uiPattern.test(text)) {
          continue;
        }
        if (seen.has(text)) {
          continue;
        }
        seen.add(text);
        uniqueLines.push(text);
      }

      if (uniqueLines.length > 0) {
        return uniqueLines.join(" ").slice(0, 1200);
      }

      const fallback = normalize(container.textContent);
      if (!fallback || fallback.length < 2) {
        return "";
      }
      return fallback.slice(0, 1200);
    });
  } catch (error) {
    if (isTransientContextError(error)) {
      return "";
    }
    throw error;
  }
}

async function extractPostPreview(page) {
  const extracted = await page.evaluate(() => {
    const getMeta = (prop, attr = "property") => {
      const selector = `meta[${attr}="${prop}"]`;
      const value = document.querySelector(selector)?.getAttribute("content") || "";
      return value.trim();
    };

    const ogTitle = getMeta("og:title");
    const ogDescription = getMeta("og:description");

    const firstReadableText = Array.from(document.querySelectorAll("div[dir='auto']"))
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
      .find((text) => text.length >= 30 && text.length <= 500);

    return {
      ogTitle,
      ogDescription,
      firstReadableText: firstReadableText || ""
    };
  });

  const pageTitle = (await page.title()).trim();

  return {
    title: extracted.ogTitle || pageTitle,
    description: extracted.ogDescription || "",
    snippet: extracted.firstReadableText || ""
  };
}

async function fetchPostInfo({ postUrl, log, maxFetchComments = DEFAULT_MAX_FETCH_COMMENTS }) {
  const { browser, mode } = await connectBrowser(log);
  let context = null;

  try {
    const result = await getOrCreatePage(browser, mode);
    context = result.context;
    const { page } = result;

    const cookies = loadCookiesFromEnv(log);
    if (cookies.length > 0) {
      await context.addCookies(cookies);
      log("Injected cookies into browser context.");
    }

    log(`Fetching post URL: ${postUrl}`);
    await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(2500);
    await assertLoggedIn(page);

    const preview = await extractPostPreview(page);
    const commentsByKey = new Map();
    let idleLoops = 0;

    while (idleLoops < DEFAULT_MAX_IDLE_LOOPS + 3 && commentsByKey.size < maxFetchComments) {
      try {
        await assertLoggedIn(page);
        await clickLoadMoreButtons(page);

        const replyButtons = await getReplyButtons(page);
        let addedThisLoop = 0;

        for (const button of replyButtons) {
          if (commentsByKey.size >= maxFetchComments) {
            break;
          }

          const key = await getCommentKey(button);
          if (!key || commentsByKey.has(key)) {
            continue;
          }

          const text = await getCommentText(button);
          if (!text) {
            continue;
          }

          commentsByKey.set(key, text);
          addedThisLoop += 1;
        }

        if (addedThisLoop === 0) {
          idleLoops += 1;
        } else {
          idleLoops = 0;
          log(`Fetched ${commentsByKey.size} comment(s) so far...`);
        }
      } catch (error) {
        if (!isTransientContextError(error)) {
          throw error;
        }
        log("Navigation detected while fetching comments. Retrying...");
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      }

      await page.mouse.wheel(0, 2300);
      await page.waitForTimeout(900);
    }

    const comments = Array.from(commentsByKey.values());
    log(`Fetch completed with ${comments.length} comment(s).`);

    return {
      mode,
      status: "ok",
      finalUrl: page.url(),
      comments,
      commentsCount: comments.length,
      ...preview
    };
  } finally {
    if (mode === "isolated") {
      if (context) {
        await context.close().catch(() => {});
      }
    }
    await browser.close().catch(() => {});
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

    const cookies = loadCookiesFromEnv(log);
    if (cookies.length > 0) {
      await context.addCookies(cookies);
      log("Injected cookies into browser context.");
    }

    log(`Opening post URL: ${postUrl}`);
    await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(3000);
    await assertLoggedIn(page);

    let idleLoops = 0;

    while (repliedCount < maxComments && idleLoops < DEFAULT_MAX_IDLE_LOOPS) {
      try {
        await assertLoggedIn(page);
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
      } catch (error) {
        if (!isTransientContextError(error)) {
          throw error;
        }
        log("Page navigation detected during scan. Waiting and retrying.");
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1000);
        continue;
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
    }
    await browser.close().catch(() => {});
  }
}

module.exports = {
  runAutoReply,
  fetchPostInfo
};
