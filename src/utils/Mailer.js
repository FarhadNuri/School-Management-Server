import nodemailer from 'nodemailer';
import {
    MAILTRAP_HOST,
    MAILTRAP_PORT,
    MAILTRAP_USERNAME,
    MAILTRAP_PASSWORD,
} from '../config/env.js';

class EmailSender {
    constructor() {
        this.transporter = null;
    }

    getTransporter() {
        if (!this.transporter) {
            const emailUser = (process.env.EMAIL_USER || '').trim();
            const emailPass = (process.env.EMAIL_PASS || '').replace(/\s+/g, '').trim();

            if (emailUser && emailPass) {
                this.transporter = nodemailer.createTransport({
                    service: process.env.EMAIL_SERVICE || 'gmail',
                    auth: {
                        user: emailUser,
                        pass: emailPass,
                    },
                    connectionTimeout: 4000,
                    greetingTimeout: 4000,
                    socketTimeout: 5000,
                });
            } else {
                this.transporter = nodemailer.createTransport({
                    host: MAILTRAP_HOST || process.env.MAILTRAP_HOST || 'sandbox.smtp.mailtrap.io',
                    port: Number(MAILTRAP_PORT || process.env.MAILTRAP_PORT || 2525),
                    auth: {
                        user: MAILTRAP_USERNAME || process.env.MAILTRAP_USERNAME,
                        pass: MAILTRAP_PASSWORD || process.env.MAILTRAP_PASSWORD,
                    },
                    connectionTimeout: 4000,
                    greetingTimeout: 4000,
                    socketTimeout: 5000,
                });
            }
        }
        return this.transporter;
    }

    async sendEmail({ to, subject, html, text, from }) {
        if (!to || !subject || (!html && !text)) {
            throw new Error('to, subject, and html or text are required');
        }

        const rawFromEmail = from?.email || process.env.EMAIL_USER || process.env.MAILTRAP_FROM_EMAIL || 'farhadnuri559@gmail.com';
        const rawName = process.env.EMAIL_FROM_NAME || 'School Management';
        const fromName = from?.name || rawName.replace(/^["']|["']$/g, '');

        // 1. Check for HTTPS API providers first (Port 443 - never blocked by cloud hosts like Render)
        const resendKey = (process.env.RESEND_API_KEY || '').trim();
        if (resendKey) {
            try {
                const fromAddress = process.env.RESEND_FROM || 'onboarding@resend.dev';
                const res = await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${resendKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        from: `"${fromName}" <${fromAddress}>`,
                        to: Array.isArray(to) ? to : [to],
                        subject,
                        ...(html && { html }),
                        ...(text && { text }),
                    }),
                    signal: AbortSignal.timeout(5000),
                });
                if (res.ok) {
                    const data = await res.json().catch(() => ({}));
                    console.log(`✉️ Email successfully delivered via Resend API to ${to} (id: ${data.id})`);
                    return data;
                }
                const errData = await res.json().catch(() => ({}));
                console.warn('Resend API responded with error:', errData);
            } catch (err) {
                console.warn('Resend API call failed:', err.message);
            }
        }

        const brevoKey = (process.env.BREVO_API_KEY || '').trim();
        if (brevoKey) {
            try {
                const res = await fetch('https://api.brevo.com/v3/smtp/email', {
                    method: 'POST',
                    headers: {
                        'api-key': brevoKey,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        sender: { name: fromName, email: rawFromEmail },
                        to: [{ email: to }],
                        subject,
                        ...(html && { htmlContent: html }),
                        ...(text && { textContent: text }),
                    }),
                    signal: AbortSignal.timeout(5000),
                });
                if (res.ok) {
                    const data = await res.json().catch(() => ({}));
                    console.log(`✉️ Email successfully delivered via Brevo API to ${to}`);
                    return data;
                }
                const errData = await res.json().catch(() => ({}));
                console.warn('Brevo API responded with error:', errData);
            } catch (err) {
                console.warn('Brevo API call failed:', err.message);
            }
        }

        // 2. Mailtrap Sending API over HTTPS (Port 443)
        const mailtrapToken = (process.env.MAILTRAP_TOKEN || process.env.MAILTRAP_API_TOKEN || '').trim();
        if (mailtrapToken && mailtrapToken.length > 20 && !mailtrapToken.includes(' ')) {
            try {
                const res = await fetch('https://send.api.mailtrap.io/api/send', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${mailtrapToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        from: { email: rawFromEmail, name: fromName },
                        to: [{ email: to }],
                        subject,
                        ...(text && { text }),
                        ...(html && { html }),
                    }),
                    signal: AbortSignal.timeout(5000),
                });
                if (res.ok) {
                    const data = await res.json().catch(() => ({}));
                    console.log(`✉️ Email successfully delivered via Mailtrap API to ${to}`);
                    return data;
                }
            } catch (err) {
                console.warn('Mailtrap API call failed:', err.message);
            }
        }

        // 3. Fallback to Nodemailer SMTP with strict 5-second timeout guard
        const transporter = this.getTransporter();
        const mailOptions = {
            from: `"${fromName}" <${rawFromEmail}>`,
            to,
            subject,
            ...(text && { text }),
            ...(html && { html }),
        };

        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Nodemailer SMTP timed out after 5000ms (outbound SMTP is blocked on free tier host)')), 5000)
        );

        const info = await Promise.race([
            transporter.sendMail(mailOptions),
            timeoutPromise,
        ]);

        console.log(`✉️ Real email successfully delivered via SMTP to ${to} (MessageId: ${info.messageId})`);
        return info;
    }
}

const mailer = new EmailSender();

export { EmailSender };
export default mailer;
