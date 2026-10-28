import { t } from "@gametracker/shared";
import { env } from "../env.js";

export class EmailSendError extends Error {}

type Letter = { subject: string; html: string; text: string };

// Sends through Resend's HTTP API: hosts often block outgoing SMTP ports, HTTPS always goes through.
export async function sendEmail(to: string, letter: Letter): Promise<void> {
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.emailFrom, to: [to], ...letter }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new EmailSendError(`Resend request failed: ${String(error)}`);
  }
  if (!response.ok) {
    throw new EmailSendError(`Resend failed with ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
}

export function codeLetter(purpose: "signup" | "reset", code: string): Letter {
  const subject = purpose === "signup" ? t("email.signupSubject") : t("email.resetSubject");
  const lead = purpose === "signup" ? t("email.signupLead") : t("email.resetLead");
  const hint = t("email.codeHint");
  const html = `<!doctype html>
<html lang="uk">
<body style="margin:0;padding:32px 16px;background:#f4f5f8;font-family:Arial,Helvetica,sans-serif;color:#11141b">
  <div style="max-width:440px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px">
    <p style="margin:0 0 8px;font-size:14px;font-weight:bold;color:#4a6500">GameTracker</p>
    <h1 style="margin:0 0 16px;font-size:22px">${subject}</h1>
    <p style="margin:0 0 24px;font-size:15px;line-height:1.5">${lead}</p>
    <p style="margin:0 0 24px;font-size:34px;font-weight:bold;letter-spacing:8px">${code}</p>
    <p style="margin:0;font-size:13px;line-height:1.5;color:#5a6272">${hint}</p>
  </div>
</body>
</html>`;
  return { subject, html, text: `${subject}\n\n${lead}\n\n${code}\n\n${hint}` };
}
