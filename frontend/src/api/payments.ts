import { typedApiRequest } from "./typedClient";

export interface CreatePaymentOrderPayload {
  course_id: number;
  plan: "full" | "monthly";
  buyer_name: string;
  buyer_email: string;
  whatsapp_number: string;
  alternate_number?: string;
  age?: number;
  country?: string;
  state?: string;
  city?: string;
  pincode?: string;
}

export interface VerifyPaymentPayload {
  course_id: number;
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
  checkout_reference?: string;
}

export const createPaymentOrder = (payload: CreatePaymentOrderPayload) =>
  typedApiRequest("post", "/payment/create-order/", { data: payload });

export const verifyPayment = (payload: VerifyPaymentPayload) =>
  typedApiRequest("post", "/payment/verify/", { data: payload });
