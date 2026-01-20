-- Enable pgcrypto (should be done once per project)
-- create extension if not exists pgcrypto;

create or replace function totp_store(user_id uuid, secret text)
returns void
language sql
security definer
as $$
insert into public.totp_secrets (user_id, secret_encrypted, enabled)
values ($1, pgp_sym_encrypt($2, current_setting('vault.TOTP_MASTER_KEY')), true)
on conflict (user_id) do update set secret_encrypted = excluded.secret_encrypted, enabled = true;
$$;

create or replace function totp_get(user_id uuid)
returns text
language sql
security definer
as $$
select pgp_sym_decrypt(secret_encrypted, current_setting('vault.TOTP_MASTER_KEY'))::text
from public.totp_secrets
where user_id = $1 and enabled = true
limit 1;
$$;
