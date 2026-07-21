// Row shapes the dashboard reads. These mirror the Supabase schema; swap for
// generated types (`supabase gen types typescript`) once the schema settles.

export type Channel = "email" | "voice";

export type JsonObject = Record<string, unknown>;

export type ClientRow = {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  store_platform: string | null;
  store_base_url: string | null;
  store_credentials_ref: string | null;
  shipstation_credentials_ref: string | null;
  support_email: string | null;
  phone_number: string | null;
  brand_tone_config: JsonObject;
  abnormal_status_rules: JsonObject;
  business_hours: JsonObject;
  settings: JsonObject;
};

export type ConversationRow = {
  id: string;
  channel: Channel;
  customer_name: string | null;
  customer_identifier: string | null;
  subject: string | null;
  status: string;
  flagged: boolean;
  flag_reason: string | null;
  order_number: string | null;
  booking_outcome: string | null;
  last_message_at: string | null;
  created_at: string;
};

export type MessageRow = {
  id: string;
  role: "customer" | "agent" | "human";
  body: string | null;
  audio_url: string | null;
  model: string | null;
  created_at: string;
};

export type ReviewConversationRef = {
  id: string;
  customer_name: string | null;
  customer_identifier: string | null;
  subject: string | null;
  order_number: string | null;
  status: string;
} | null;

export type ReviewItemRow = {
  id: string;
  reason: string;
  details: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
  conversation_id: string | null;
  // Embedded via the conversation_id FK.
  conversations: ReviewConversationRef;
};

export type OrderLineItem = {
  sku?: string;
  name?: string;
  quantity?: number;
  total?: string;
};

export type OrderRow = {
  order_number: string;
  store_platform: string | null;
  store_status: string | null;
  is_abnormal: boolean | null;
  customer_name: string | null;
  customer_email: string | null;
  currency: string | null;
  order_total: number | string | null;
  order_placed_at: string | null;
  line_items: OrderLineItem[];
  tracking_number: string | null;
  carrier: string | null;
  shipping_status: string | null;
  shipped_at: string | null;
  estimated_delivery: string | null;
  fetched_at: string | null;
};

// --- Scheduling ---

export type PriceType = "fixed" | "quote";

export type ServiceRow = {
  id: string;
  name: string;
  category: string | null;
  price_type: PriceType;
  price: number | string | null;
  callout_fee: number | string | null;
  default_duration_min: number;
  emergency_eligible: boolean;
  active: boolean;
};

export type AppointmentRow = {
  id: string;
  conversation_id: string | null;
  service_id: string | null;
  service_name: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  service_address: string | null;
  is_emergency: boolean;
  starts_at: string;
  ends_at: string;
  timezone: string | null;
  status: string;
  source: string;
  price_type: PriceType | null;
  currency: string | null;
  committed_amount: number | string | null;
  estimated_value: number | string | null;
  final_value: number | string | null;
  revenue_status: string;
  notes: string | null;
  created_at: string;
};
