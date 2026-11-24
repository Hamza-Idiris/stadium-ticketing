create extension if not exists pgcrypto;
create type app_role as enum ('super_admin','stadium_admin','gate_staff','customer');
create type match_status as enum ('upcoming','live','completed','cancelled');
create type booking_status as enum ('reserved','confirmed','expired','cancelled');
create type payment_status as enum ('pending','paid','failed','rejected','refunded');
create type ticket_status as enum ('valid','used','cancelled','refunded');
create type booking_mode as enum ('paid','free_booking','open_entry');

create table profiles(id uuid primary key references auth.users on delete cascade, full_name text, phone text, role app_role not null default 'customer', active boolean not null default true, created_at timestamptz not null default now());
create table stadiums(id uuid primary key default gen_random_uuid(), name text not null, city text, created_at timestamptz default now());
create table teams(id uuid primary key default gen_random_uuid(), name text not null unique, logo_url text);
create table matches(id uuid primary key default gen_random_uuid(), stadium_id uuid not null references stadiums, title text not null, tournament text, home_team_id uuid not null references teams, away_team_id uuid not null references teams, kickoff timestamptz not null, description text, status match_status not null default 'upcoming', sales_open timestamptz, sales_close timestamptz, created_at timestamptz default now(), check (home_team_id<>away_team_id));
create table sections(id uuid primary key default gen_random_uuid(), stadium_id uuid not null references stadiums, name text not null, description text, image_url text, capacity int not null check(capacity>=0), numbered boolean not null default true, row_size int not null default 20 check(row_size>0), display_order int not null default 0, active boolean not null default true, unique(stadium_id,name));
create table match_sections(id uuid primary key default gen_random_uuid(), match_id uuid not null references matches on delete cascade, section_id uuid not null references sections, price numeric(12,2) not null default 0 check(price>=0), currency text not null default 'USD' check(currency in ('USD','SOS')), capacity int not null check(capacity>=0), mode booking_mode not null default 'paid', active boolean not null default true, unique(match_id,section_id), check(mode='paid' or price=0));
create table bookings(id uuid primary key default gen_random_uuid(), match_section_id uuid not null references match_sections, user_id uuid not null references profiles, customer_name text not null, customer_phone text not null, qty int not null check(qty between 1 and 50), status booking_status not null default 'reserved', expires_at timestamptz, created_at timestamptz not null default now());
create table booking_seats(booking_id uuid not null references bookings on delete cascade, match_section_id uuid not null references match_sections, seat_no int not null check(seat_no>0), primary key(match_section_id,seat_no));
create table payments(id uuid primary key default gen_random_uuid(), booking_id uuid not null references bookings, method text, amount numeric(12,2) not null check(amount>=0), currency text not null check(currency in ('USD','SOS')), status payment_status not null default 'pending', provider_ref text, verified_by uuid references profiles, verified_at timestamptz, created_at timestamptz not null default now());
create unique index payments_ref_uq on payments(method,provider_ref) where provider_ref is not null;
create table tickets(id uuid primary key default gen_random_uuid(), booking_id uuid not null references bookings, match_section_id uuid not null references match_sections, seat_no int, seat_code text, holder_name text not null, token text not null unique, price numeric(12,2) not null, currency text not null, status ticket_status not null default 'valid', used_at timestamptz, created_at timestamptz not null default now());
create unique index tickets_seat_uq on tickets(match_section_id,seat_no) where seat_no is not null and status in ('valid','used');
create table gates(id uuid primary key default gen_random_uuid(), name text not null unique);
create table ticket_scans(id bigserial primary key, ticket_id uuid references tickets, token_tail text, gate_id uuid references gates, staff_id uuid references profiles, result text not null, scanned_at timestamptz not null default now());
create table entry_counts(match_section_id uuid primary key references match_sections, occupancy int not null default 0 check(occupancy>=0));
create table entry_log(id bigserial primary key, match_section_id uuid not null references match_sections, delta int not null, reason text, staff_id uuid references profiles, created_at timestamptz not null default now());
create table refunds(id uuid primary key default gen_random_uuid(), payment_id uuid not null references payments, amount numeric(12,2) not null check(amount>=0), reason text, processed_by uuid references profiles, created_at timestamptz not null default now());
create table site_texts(key text not null, lang text not null check(lang in ('en','so')), value text not null, primary key(key,lang));
create table footer_links(id uuid primary key default gen_random_uuid(), label text not null, url text not null check(url ~* '^(https?:|tel:|mailto:)'), sort int not null default 0);
create table contact_messages(id uuid primary key default gen_random_uuid(), topic text not null, name text not null, contact text not null, message text not null, created_at timestamptz not null default now());
create table audit_logs(id bigserial primary key, actor uuid, action text not null, entity text, entity_id text, detail jsonb, created_at timestamptz not null default now());
create table settings(key text primary key, value text not null);
create index on bookings(user_id); create index on bookings(status,expires_at); create index on tickets(booking_id); create index on ticket_scans(ticket_id); create index on matches(kickoff);

create or replace function my_role() returns app_role language sql stable security definer set search_path=public as $$ select role from profiles where id=auth.uid() and active $$;
create or replace function handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$ begin insert into profiles(id,full_name) values(new.id,new.raw_user_meta_data->>'full_name') on conflict (id) do nothing; return new; end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

do $$ declare t text; begin
 foreach t in array array['profiles','stadiums','teams','matches','sections','match_sections','bookings','booking_seats','payments','tickets','gates','ticket_scans','entry_counts','entry_log','refunds','site_texts','footer_links','contact_messages','audit_logs','settings'] loop
  execute format('alter table %I enable row level security',t);
  execute format('drop policy if exists admin_all on %I',t);
  execute format('create policy admin_all on %I for all to authenticated using (my_role() in (''super_admin'',''stadium_admin'')) with check (my_role() in (''super_admin'',''stadium_admin''))',t);
 end loop;
 foreach t in array array['stadiums','teams','matches','sections','match_sections','site_texts','footer_links'] loop
  execute format('drop policy if exists public_read on %I',t);
  execute format('create policy public_read on %I for select using (true)',t);
 end loop;
end $$;
drop policy if exists own_profile on profiles;
create policy own_profile on profiles for select to authenticated using (id=auth.uid());
drop policy if exists own_bookings on bookings;
create policy own_bookings on bookings for select to authenticated using (user_id=auth.uid());
drop policy if exists own_tickets on tickets;
create policy own_tickets on tickets for select to authenticated using (booking_id in (select id from bookings where user_id=auth.uid()));
drop policy if exists own_payments on payments;
create policy own_payments on payments for select to authenticated using (booking_id in (select id from bookings where user_id=auth.uid()));
drop policy if exists send_contact on contact_messages;
create policy send_contact on contact_messages for insert to anon, authenticated with check (true);
drop policy if exists gate_read_gates on gates;
create policy gate_read_gates on gates for select to authenticated using (my_role()='gate_staff');
drop policy if exists gate_read_counts on entry_counts;
create policy gate_read_counts on entry_counts for select to authenticated using (my_role()='gate_staff');

-- Backfill any users already created in auth.users before this migration ran
insert into profiles(id, full_name, role)
select id, coalesce(raw_user_meta_data->>'full_name', email), 'customer'
from auth.users
on conflict (id) do nothing;

grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all routines in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on routines to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
