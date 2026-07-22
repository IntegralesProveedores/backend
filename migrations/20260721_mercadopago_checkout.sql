-- Mercado Pago Checkout Pro
-- Requiere aplicarse antes de habilitar el procesamiento productivo de pagos.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS external_reference text,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS stock_decremented_at timestamptz;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_payment_status_check;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_payment_status_check
  CHECK (payment_status = ANY (ARRAY[
    'pending'::text,
    'approved'::text,
    'in_process'::text,
    'rejected'::text,
    'cancelled'::text,
    'refunded'::text,
    'charged_back'::text
  ]));

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_status_check;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_status_check
  CHECK (status = ANY (ARRAY[
    'pending'::text,
    'approved'::text,
    'in_process'::text,
    'rejected'::text,
    'cancelled'::text,
    'refunded'::text,
    'charged_back'::text
  ]));

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_external_reference
  ON public.orders (external_reference)
  WHERE external_reference IS NOT NULL;

CREATE OR REPLACE FUNCTION public.decrement_order_stock(p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  order_item record;
BEGIN
  UPDATE public.orders
  SET stock_decremented_at = now(), updated_at = now()
  WHERE id = p_order_id
    AND stock_decremented_at IS NULL;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  FOR order_item IN
    SELECT product_variant_id, quantity
    FROM public.order_items
    WHERE order_id = p_order_id
  LOOP
    UPDATE public.product_variants
    SET stock = stock - order_item.quantity,
        updated_at = now()
    WHERE id = order_item.product_variant_id
      AND stock >= order_item.quantity;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Insufficient stock for variant %', order_item.product_variant_id;
    END IF;
  END LOOP;

  RETURN true;
END;
$$;
