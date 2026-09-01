-- Datos bancarios para pago por transferencia, mostrados en el email de confirmación de pedido.
-- Reemplaza los valores que estaban hardcodeados en frontend/src/app/core/services/order-email-template.service.ts (F2).
CREATE TABLE IF NOT EXISTS public.payment_transfer_info (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_name text NOT NULL,
  alias text NOT NULL,
  cvu text,
  cbu text,
  account_number text,
  account_holder_name text NOT NULL,
  account_holder_tax_id text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payment_transfer_info IS 'Cuentas bancarias/billeteras para pago por transferencia; una fila por cuenta (Mercado Pago, Banco Nación, etc).';

ALTER TABLE public.payment_transfer_info ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read payment_transfer_info" ON public.payment_transfer_info
  FOR SELECT TO anon
  USING (active = true);

INSERT INTO public.payment_transfer_info
  (bank_name, alias, cvu, cbu, account_number, account_holder_name, account_holder_tax_id, position, active)
VALUES
  ('Mercado Pago', 'brotalia', '0000003100047366574097', NULL, NULL, 'Luciano German Farina', '24304556605', 1, true),
  ('Banco Nacion', 'farinagerman.bna', NULL, '0110006830000620409251', 'CA $ N°00300062040925', 'Luciano Germán Farina', '24304556605', 2, true);
