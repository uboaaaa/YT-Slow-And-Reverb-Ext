/**
 * Bug-report bridge: Google Form submission -> GitHub issue.
 *
 * This file is a committed copy for reference; it RUNS in Google Apps Script,
 * not in the extension. Setup:
 *
 *  1. Create the Google Form. Question titles must match FIELD_TITLES below
 *     exactly (or edit FIELD_TITLES to match the form).
 *  2. In the form editor: three-dot menu -> Apps Script. Paste this file.
 *  3. In the script editor: Project Settings -> Script Properties -> add
 *     GITHUB_TOKEN = a fine-grained personal access token scoped to ONLY this
 *     repo with ONLY "Issues: read and write" permission.
 *  4. In the script editor: Triggers -> Add Trigger -> onFormSubmit,
 *     event source "From form", event type "On form submit".
 *  5. In the trigger's failure-notification setting, pick "Notify me
 *     immediately" so broken submissions are not lost silently.
 *  6. Form settings: do NOT require sign-in, do NOT collect email addresses.
 *
 * Test by submitting the form once and checking the repo's issues.
 */

const GITHUB_REPO = "uboaaaa/lento-ext";
const ISSUE_LABELS = ["bug", "from-form"];

// Question titles, exactly as they appear on the form.
const FIELD_TITLES = {
  site: "Which site were you on?",
  happened: "What happened?",
  expected: "What was supposed to happen?",
  browser: "What browser are you using (and its version, if possible)?",
};

function onFormSubmit(e) {
  const answers = {};
  e.response.getItemResponses().forEach(function (itemResponse) {
    answers[itemResponse.getItem().getTitle()] = String(
      itemResponse.getResponse() || ""
    ).trim();
  });

  const get = function (key) {
    return answers[FIELD_TITLES[key]] || "_not provided_";
  };

  const site = get("site");
  const title = "[form] " + site.replace(/^https?:\/\//, "").slice(0, 70);

  const body = [
    "### Which site were you on?",
    site,
    "",
    "### What happened?",
    get("happened"),
    "",
    "### What was supposed to happen?",
    get("expected"),
    "",
    "### Browser",
    get("browser"),
    "",
    "_Filed via the bug-report form._",
  ].join("\n");

  const token =
    PropertiesService.getScriptProperties().getProperty("GITHUB_TOKEN");
  if (!token) {
    throw new Error("GITHUB_TOKEN is missing from Script Properties.");
  }

  const response = UrlFetchApp.fetch(
    "https://api.github.com/repos/" + GITHUB_REPO + "/issues",
    {
      method: "post",
      contentType: "application/json",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
      },
      payload: JSON.stringify({
        title: title,
        body: body,
        labels: ISSUE_LABELS,
      }),
      muteHttpExceptions: true,
    }
  );

  if (response.getResponseCode() >= 300) {
    // Throwing makes the failure visible in trigger notifications.
    throw new Error(
      "GitHub API returned " +
        response.getResponseCode() +
        ": " +
        response.getContentText().slice(0, 500)
    );
  }
}
