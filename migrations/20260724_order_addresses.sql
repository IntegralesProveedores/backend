-- Dirección y modalidad de envío asociadas 1:1 a cada orden.
CREATE TABLE IF NOT EXISTS public.order_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE CASCADE,
  recipient_name text,
  postal_code text,
  province text,
  locality text,
  county text,
  street text,
  street_number text,
  floor text,
  apartment text,
  country text,
  shipping_method text NOT NULL CHECK (shipping_method IN ('pickup', 'delivery')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.order_addresses IS 'Dirección y modalidad de envío de una orden; para pickup los campos de dirección son NULL.';
