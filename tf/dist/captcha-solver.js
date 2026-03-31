/**
 * CAPTCHA solving via 2Captcha API.
 * Supports reCAPTCHA v2 and hCaptcha for headless cloud operation.
 *
 * Set CAPTCHA_API_KEY env var to enable. Without it, falls back
 * to headed browser (user solves manually).
 */
const API_KEY = process.env.CAPTCHA_API_KEY || "";
const CREATE_URL = "https://api.2captcha.com/createTask";
const RESULT_URL = "https://api.2captcha.com/getTaskResult";
const POLL_INTERVAL = 5_000;
const MAX_WAIT = 120_000;
export function isCaptchaSolverEnabled() {
    return API_KEY.length > 0;
}
async function createTask(task) {
    const res = await fetch(CREATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: API_KEY, task }),
    });
    const data = (await res.json());
    if (data.errorId !== 0) {
        throw new Error(`2Captcha createTask error: ${data.errorCode} — ${data.errorDescription}`);
    }
    return data.taskId;
}
async function getResult(taskId) {
    const start = Date.now();
    while (Date.now() - start < MAX_WAIT) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
        const res = await fetch(RESULT_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientKey: API_KEY, taskId }),
        });
        const data = (await res.json());
        if (data.errorId !== 0) {
            throw new Error(`2Captcha error: ${data.errorCode} — ${data.errorDescription}`);
        }
        if (data.status === "ready") {
            return data.solution?.gRecaptchaResponse || data.solution?.token || "";
        }
    }
    throw new Error("CAPTCHA solve timed out (120s)");
}
/**
 * Solve a reCAPTCHA v2 challenge.
 * @param pageUrl - The URL of the page with the CAPTCHA
 * @param siteKey - The reCAPTCHA site key (data-sitekey attribute)
 */
export async function solveRecaptchaV2(pageUrl, siteKey) {
    if (!isCaptchaSolverEnabled()) {
        throw new Error("CAPTCHA_API_KEY not set — cannot solve reCAPTCHA in headless mode");
    }
    console.error(`[captcha] Solving reCAPTCHA v2 for ${pageUrl}...`);
    const taskId = await createTask({
        type: "RecaptchaV2TaskProxyless",
        websiteURL: pageUrl,
        websiteKey: siteKey,
    });
    const token = await getResult(taskId);
    console.error(`[captcha] reCAPTCHA solved.`);
    return token;
}
/**
 * Solve an hCaptcha challenge.
 * @param pageUrl - The URL of the page with the CAPTCHA
 * @param siteKey - The hCaptcha site key
 */
export async function solveHCaptcha(pageUrl, siteKey) {
    if (!isCaptchaSolverEnabled()) {
        throw new Error("CAPTCHA_API_KEY not set — cannot solve hCaptcha in headless mode");
    }
    console.error(`[captcha] Solving hCaptcha for ${pageUrl}...`);
    const taskId = await createTask({
        type: "HCaptchaTaskProxyless",
        websiteURL: pageUrl,
        websiteKey: siteKey,
    });
    const token = await getResult(taskId);
    console.error(`[captcha] hCaptcha solved.`);
    return token;
}
/**
 * Extract a reCAPTCHA site key from a Playwright page.
 */
export async function extractRecaptchaSiteKey(page) {
    return page.evaluate(() => {
        // Check data-sitekey attribute
        const el = document.querySelector("[data-sitekey]");
        if (el)
            return el.getAttribute("data-sitekey");
        // Check iframe src
        const iframe = document.querySelector("iframe[src*='recaptcha']");
        if (iframe) {
            const match = iframe.src.match(/[?&]k=([^&]+)/);
            if (match)
                return match[1];
        }
        return null;
    });
}
/**
 * Extract an hCaptcha site key from a Playwright page.
 */
export async function extractHCaptchaSiteKey(page) {
    return page.evaluate(() => {
        const el = document.querySelector("[data-sitekey]");
        if (el)
            return el.getAttribute("data-sitekey");
        const iframe = document.querySelector("iframe[src*='hcaptcha']");
        if (iframe) {
            const match = iframe.src.match(/sitekey=([^&]+)/);
            if (match)
                return match[1];
        }
        return null;
    });
}
/**
 * Inject a solved CAPTCHA token into the page and submit.
 */
export async function injectRecaptchaToken(page, token) {
    await page.evaluate((t) => {
        // Set the response textarea (hidden by reCAPTCHA widget)
        const textarea = document.querySelector("#g-recaptcha-response, [name='g-recaptcha-response']");
        if (textarea) {
            textarea.style.display = "block";
            textarea.value = t;
        }
        // Trigger the callback if registered
        const widgetId = 0;
        if (typeof window.___grecaptcha_cfg !== "undefined") {
            const clients = window.___grecaptcha_cfg?.clients;
            if (clients) {
                for (const client of Object.values(clients)) {
                    for (const val of Object.values(client)) {
                        if (val?.callback && typeof val.callback === "function") {
                            val.callback(t);
                            return;
                        }
                    }
                }
            }
        }
        // Also try the global grecaptcha callback
        if (window.grecaptcha?.enterprise?.execute)
            return;
        if (window.grecaptcha?.getResponse)
            return;
    }, token);
}
/**
 * Inject a solved hCaptcha token into the page.
 */
export async function injectHCaptchaToken(page, token) {
    await page.evaluate((t) => {
        const textarea = document.querySelector("[name='h-captcha-response'], [name='g-recaptcha-response']");
        if (textarea) {
            textarea.style.display = "block";
            textarea.value = t;
        }
        // Trigger hcaptcha callback
        if (window.hcaptcha) {
            try {
                const iframes = document.querySelectorAll("iframe[src*='hcaptcha']");
                iframes.forEach((f) => f.remove());
            }
            catch { }
        }
    }, token);
}
//# sourceMappingURL=captcha-solver.js.map