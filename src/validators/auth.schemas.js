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

/** Signup consent checkbox — "I agree to the Terms and Privacy Policy" */
const acceptTerms = z.literal(true, {
  errorMap: () => ({ message: "You must agree to the Terms and Privacy Policy" }),
});

export const signupSchema = z.object({
  acceptTerms,
  fullName: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(72),
  phone: optionalUsPhone,
  role: z.enum(["rider", "driver"]).optional().default("rider"),
});

/** Email + password, or (phone accounts) phone + password. */
export const loginSchema = z
  .object({
    email: z.string().trim().email().optional(),
    phone: z.string().trim().optional(),
    password: z.string().min(1).max(72),
  })
  .refine((d) => d.email || d.phone, { message: "Enter your email or phone number" });

const usPhone = z
  .string()
  .trim()
  .refine((v) => isCompleteUsPhone(v), "Enter a valid 10-digit US phone (e.g. 555-201-0123)");
const smsCode = z.string().trim().regex(/^\d{4,8}$/, "Enter the code from the SMS");

export const phoneStartSchema = z.object({
  phone: usPhone,
  purpose: z.enum(["signup", "login", "reset"]).default("login"),
});

export const phoneSignupSchema = z.object({
  acceptTerms,
  fullName: z.string().trim().min(2).max(80),
  phone: usPhone,
  otp: smsCode,
  password: z.string().min(8).max(72),
  role: z.enum(["rider", "driver"]).optional().default("rider"),
});

export const phoneLoginSchema = z.object({
  phone: usPhone,
  otp: smsCode,
});

export const phoneResetSchema = z.object({
  phone: usPhone,
  otp: smsCode,
  password: z.string().min(8).max(72),
});

export const socialLoginSchema = z.object({
  idToken: z.string().min(20).max(8192),
  /** Optional display name override for a new account (else the token's name) */
  fullName: z.string().trim().max(80).optional(),
  role: z.enum(["rider", "driver"]).optional().default("rider"),
  /** Required only when this sign-in would create a new account */
  acceptTerms: z.boolean().optional(),
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
