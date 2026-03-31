/**
 * CAPTCHA solving via 2Captcha API.
 * Supports reCAPTCHA v2 and hCaptcha for headless cloud operation.
 *
 * Set CAPTCHA_API_KEY env var to enable. Without it, falls back
 * to headed browser (user solves manually).
 */
export declare function isCaptchaSolverEnabled(): boolean;
/**
 * Solve a reCAPTCHA v2 challenge.
 * @param pageUrl - The URL of the page with the CAPTCHA
 * @param siteKey - The reCAPTCHA site key (data-sitekey attribute)
 */
export declare function solveRecaptchaV2(pageUrl: string, siteKey: string): Promise<string>;
/**
 * Solve an hCaptcha challenge.
 * @param pageUrl - The URL of the page with the CAPTCHA
 * @param siteKey - The hCaptcha site key
 */
export declare function solveHCaptcha(pageUrl: string, siteKey: string): Promise<string>;
/**
 * Extract a reCAPTCHA site key from a Playwright page.
 */
export declare function extractRecaptchaSiteKey(page: import("playwright").Page): Promise<string | null>;
/**
 * Extract an hCaptcha site key from a Playwright page.
 */
export declare function extractHCaptchaSiteKey(page: import("playwright").Page): Promise<string | null>;
/**
 * Inject a solved CAPTCHA token into the page and submit.
 */
export declare function injectRecaptchaToken(page: import("playwright").Page, token: string): Promise<void>;
/**
 * Inject a solved hCaptcha token into the page.
 */
export declare function injectHCaptchaToken(page: import("playwright").Page, token: string): Promise<void>;
