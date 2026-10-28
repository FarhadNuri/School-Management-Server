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
                });
            } else {
                this.transporter = nodemailer.createTransport({
                    host: MAILTRAP_HOST || process.env.MAILTRAP_HOST || 'sandbox.smtp.mailtrap.io',
                    port: Number(MAILTRAP_PORT || process.env.MAILTRAP_PORT || 2525),
                    auth: {
                        user: MAILTRAP_USERNAME || process.env.MAILTRAP_USERNAME,
                        pass: MAILTRAP_PASSWORD || process.env.MAILTRAP_PASSWORD,
                    },
                });
            }
        }
        return this.transporter;
    }

    async sendEmail({ to, subject, html, text, from }) {
        if (!to || !subject || (!html && !text)) {
            throw new Error('to, subject, and html or text are required');
        }

        const transporter = this.getTransporter();
        const fromEmail = from?.email || process.env.EMAIL_USER || process.env.MAILTRAP_FROM_EMAIL || 'farhadnuri559@gmail.com';
        const rawName = process.env.EMAIL_FROM_NAME || 'School Management';
        const fromName = from?.name || rawName.replace(/^["']|["']$/g, '');

        const mailOptions = {
            from: `"${fromName}" <${fromEmail}>`,
            to,
            subject,
            ...(text && { text }),
            ...(html && { html }),
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`✉️ Real email successfully delivered to ${to} (MessageId: ${info.messageId})`);
        return info;
    }
}

const mailer = new EmailSender();

export { EmailSender };
export default mailer;
