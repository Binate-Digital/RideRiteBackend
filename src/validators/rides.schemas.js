import { z } from "zod";

const coordsSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  })
  .nullable()
  .optional();

export const vehicleEnum = z.enum(["sedan", "suv", "truck"]);
// Card goes through Stripe; the rest are paid to the driver at pickup.
// "cashapp" / "paypal" may still appear on old trips but aren't offered (not in the TRD).
export const paymentMethodEnum = z.enum(["card", "cash", "venmo", "zelle"]);

export const estimateSchema = z.object({
  pickup: z.string().trim().min(2).max(300),
  destination: z.string().trim().min(2).max(300),
  vehicle: vehicleEnum,
  pickupCoords: coordsSchema,
  destinationCoords: coordsSchema,
  promoCode: z.string().trim().max(40).optional(),
});

export const promoValidateSchema = z.object({
  code: z.string().trim().min(1).max(40),
  subtotalCents: z.number().int().positive().optional(),
});

export const bookRideSchema = estimateSchema.extend({
  paymentMethod: paymentMethodEnum.default("card"),
});

export const cancelRideSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

export const updateStatusSchema = z.object({
  status: z.enum(["en_route", "arrived", "in_progress", "completed"]),
});

export const rateRideSchema = z.object({
  rating: z.number().int().min(1).max(5),
  review: z.string().trim().max(500).optional(),
});

export const driverVehicleSchema = z.object({
  vehicleType: vehicleEnum.optional(),
  vehicleMake: z.string().trim().max(60).optional(),
  vehicleModel: z.string().trim().max(60).optional(),
  vehicleColor: z.string().trim().max(40).optional(),
  vehiclePlate: z.string().trim().max(20).optional(),
  vehicleYear: z.coerce.number().int().min(1990).max(2100).optional().nullable(),
  vehicleVin: z.string().trim().max(32).optional(),
});

export const driverLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
