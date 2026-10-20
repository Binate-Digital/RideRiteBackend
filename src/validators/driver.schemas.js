import { z } from "zod";
import { optionalDataUrl } from "./auth.schemas.js";

export const driverVerificationSchema = z.object({
  dateOfBirth: z.string().trim().min(4).max(32).optional(),
  addressLine1: z.string().trim().min(3).max(120).optional(),
  city: z.string().trim().min(2).max(80).optional(),
  state: z.string().trim().length(2).optional(),
  zip: z.string().trim().min(5).max(10).optional(),
  dlNumber: z.string().trim().min(4).max(40).optional(),
  dlState: z.string().trim().length(2).optional(),
  dlExpiresOn: z.string().trim().min(4).max(32).optional(),
  licenseFrontUrl: optionalDataUrl.optional(),
  licenseBackUrl: optionalDataUrl.optional(),
  vehicleType: z.enum(["sedan", "suv", "truck"]).optional(),
  vehicleMake: z.string().trim().min(1).max(60).optional(),
  vehicleModel: z.string().trim().min(1).max(60).optional(),
  vehicleColor: z.string().trim().max(40).optional(),
  vehiclePlate: z.string().trim().min(2).max(20).optional(),
  vehicleYear: z.coerce.number().int().min(1990).max(2100).optional(),
  vehicleVin: z.string().trim().length(17).optional(),
  insuranceCarrier: z.string().trim().min(2).max(80).optional(),
  insurancePolicyNumber: z.string().trim().min(2).max(60).optional(),
  insuranceExpiresOn: z.string().trim().min(4).max(32).optional(),
  skipForLater: z.boolean().optional(),
});
