import { z } from "zod";

/**
 * A driver document reference: the key returned by POST /api/uploads/driver-docs (or the value
 * already on the profile). Arbitrary URLs / data URIs are rejected in the controller.
 */
const documentRef = z.union([z.string().trim().max(1024), z.null()]);

export const driverVerificationSchema = z.object({
  dateOfBirth: z.string().trim().min(4).max(32).optional(),
  addressLine1: z.string().trim().min(3).max(120).optional(),
  city: z.string().trim().min(2).max(80).optional(),
  state: z.string().trim().length(2).optional(),
  zip: z.string().trim().min(5).max(10).optional(),
  /** Map pin for home / signup address */
  addressLat: z.coerce.number().min(-90).max(90).optional(),
  addressLng: z.coerce.number().min(-180).max(180).optional(),
  dlNumber: z.string().trim().min(4).max(40).optional(),
  dlState: z.string().trim().length(2).optional(),
  dlExpiresOn: z.string().trim().min(4).max(32).optional(),
  licenseFrontUrl: documentRef.optional(),
  licenseBackUrl: documentRef.optional(),
  vehicleType: z.enum(["sedan", "suv", "truck"]).optional(),
  vehicleMake: z.string().trim().min(1).max(60).optional(),
  vehicleModel: z.string().trim().min(1).max(60).optional(),
  vehicleColor: z.string().trim().max(40).optional(),
  vehiclePlate: z.string().trim().min(2).max(20).optional(),
  vehicleYear: z.coerce.number().int().min(1990).max(2050).optional(),
  vehicleVin: z.string().trim().min(11).max(17).optional(),
  insuranceCarrier: z.string().trim().min(2).max(80).optional(),
  insurancePolicyNumber: z.string().trim().min(2).max(60).optional(),
  insuranceExpiresOn: z.string().trim().min(4).max(32).optional(),
  /** Uploaded via POST /api/uploads/driver-docs (fields registrationDoc / insuranceDoc) */
  insuranceDocUrl: documentRef.optional(),
  registrationDocUrl: documentRef.optional(),
  registrationExpiresOn: z.string().trim().min(4).max(32).optional(),
  skipForLater: z.boolean().optional(),
});
