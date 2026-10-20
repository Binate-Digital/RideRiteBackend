import { z } from "zod";
import { formatUsPhone, isCompleteUsPhone } from "../utils/phone.js";

const optionalUsPhone = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v, ctx) => {
    if (v === undefined || v === null) return null;
    const trimmed = String(v).trim();
    if (!trimmed) return null;
    if (!isCompleteUsPhone(trimmed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter a valid 10-digit US phone (e.g. 555-201-0123)",
      });
      return z.NEVER;
    }
    return formatUsPhone(trimmed);
  });

const optionalDataUrl = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v, ctx) => {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    if (!s) return null;
    if (s.length > 2_500_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Image is too large (max ~1.8MB)",
      });
      return z.NEVER;
    }
    if (!s.startsWith("data:image/") && !s.startsWith("http")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid image data",
      });
      return z.NEVER;
    }
    return s;
  });

export const signupSchema = z.object({
  fullName: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(72),
  phone: optionalUsPhone,
  role: z.enum(["rider", "driver"]).optional().default("rider"),
});

export const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(72),
});

/** Prefer email + 6-digit OTP; legacy long token still accepted. */
export const verifyEmailSchema = z
  .object({
    email: z.string().trim().email().optional(),
    otp: z
      .string()
      .trim()
      .regex(/^\d{6}$/, "Enter the 6-digit code from your email")
      .optional(),
    token: z.string().trim().min(6).optional(),
  })
  .refine((d) => (d.email && d.otp) || d.token, {
    message: "Provide email + OTP, or a verification token",
  });

export const resendVerificationSchema = z.object({
  email: z.string().trim().email(),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(8).max(72),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(72),
  newPassword: z.string().min(8).max(72),
});

export const updateProfileSchema = z.object({
  fullName: z.string().trim().min(2).max(80).optional(),
  phone: optionalUsPhone.optional(),
  avatarUrl: optionalDataUrl.optional(),
  profileCompleted: z.boolean().optional(),
});

export { optionalDataUrl };
