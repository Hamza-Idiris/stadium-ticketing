create or replace function app_setting(k text, d text) returns text language sql stable as $$ select coalesce((select value from settings where key=k), d) $$;

create or replace function expire_reservations() returns int language plpgsql security definer set search_path=public as $$
declare n int; begin
 with e as (update bookings set status='expired' where status='reserved' and expires_at<now() returning id),
 d as (delete from booking_seats where booking_id in (select id from e))
 select count(*) into n from e;
 update payments set status='failed' where status='pending' and booking_id in (select id from bookings where status='expired');
 return n; end $$;

create or replace function _issue_tickets(p_booking uuid) returns void language plpgsql security definer set search_path=public, extensions as $$
declare b bookings; ms match_sections; s sections; begin
 select * into b from bookings where id=p_booking;
 select * into ms from match_sections where id=b.match_section_id;
 select * into s from sections where id=ms.section_id;
 if s.numbered then
  insert into tickets(booking_id,match_section_id,seat_no,seat_code,holder_name,token,price,currency)
  select b.id,ms.id,bs.seat_no, upper(left(s.name,3))||'-R'||(((bs.seat_no-1)/s.row_size)+1)||'-S'||lpad((((bs.seat_no-1)%s.row_size)+1)::text,2,'0'), b.customer_name, encode(gen_random_bytes(24),'hex'), ms.price, ms.currency
  from booking_seats bs where bs.booking_id=b.id order by bs.seat_no;
 else
  insert into tickets(booking_id,match_section_id,holder_name,token,price,currency)
  select b.id,ms.id,b.customer_name, encode(gen_random_bytes(24),'hex'), ms.price, ms.currency from generate_series(1,b.qty);
 end if;
 update bookings set status='confirmed' where id=b.id; end $$;

-- Reserve capacity atomically. Groups get ADJACENT seats in one row.
create or replace function reserve_booking(p_ms uuid, p_qty int, p_name text, p_phone text) returns uuid language plpgsql security definer set search_path=public as $$
declare ms match_sections; s sections; m matches; avail int; st int; bid uuid; maxq int := app_setting('max_tickets_per_booking','10')::int; begin
 if auth.uid() is null then raise exception 'LOGIN_REQUIRED'; end if;
 perform expire_reservations();
 select * into ms from match_sections where id=p_ms for update;
 if not found or not ms.active then raise exception 'SECTION_UNAVAILABLE'; end if;
 select * into m from matches where id=ms.match_id;
 if m.status<>'upcoming' or (m.sales_open is not null and now()<m.sales_open) or (m.sales_close is not null and now()>m.sales_close) then raise exception 'SALES_CLOSED'; end if;
 if ms.mode='open_entry' then raise exception 'OPEN_ENTRY_NO_BOOKING'; end if;
 if p_qty<1 or p_qty>maxq then raise exception 'BAD_QUANTITY'; end if;
 select * into s from sections where id=ms.section_id;
 select ms.capacity-coalesce(sum(qty),0) into avail from bookings where match_section_id=ms.id and status in ('reserved','confirmed');
 if avail<p_qty then raise exception 'SOLD_OUT'; end if;
 if s.numbered then
  with free as (select n, (n-1)/s.row_size as r from generate_series(1,ms.capacity) n where n not in (select seat_no from booking_seats where match_section_id=ms.id)),
  runs as (select n, r, n-row_number() over(partition by r order by n) g from free),
  blk as (select min(n) a from runs group by r,g having count(*)>=p_qty order by min(n) limit 1)
  select a into st from blk;
  if st is null then raise exception 'NO_ADJACENT_SEATS'; end if;
 end if;
 insert into bookings(match_section_id,user_id,customer_name,customer_phone,qty,expires_at)
 values(ms.id,auth.uid(),p_name,p_phone,p_qty,now()+make_interval(mins=>app_setting('hold_minutes','10')::int)) returning id into bid;
 if s.numbered then insert into booking_seats select bid,ms.id,g from generate_series(st,st+p_qty-1) g; end if;
 if ms.price=0 then perform _issue_tickets(bid);
 else insert into payments(booking_id,amount,currency) values(bid,ms.price*p_qty,ms.currency); end if;
 return bid; end $$;

-- Tickets are created ONLY here (or for free sections), after verified payment.
create or replace function confirm_payment(p_payment uuid, p_method text, p_ref text) returns void language plpgsql security definer set search_path=public as $$
declare p payments; b bookings; begin
 if coalesce(my_role()::text,'') not in ('super_admin','stadium_admin') and coalesce(auth.role(),'')<>'service_role' then raise exception 'FORBIDDEN'; end if;
 select * into p from payments where id=p_payment for update;
 if not found or p.status<>'pending' then raise exception 'PAYMENT_NOT_PENDING'; end if;
 select * into b from bookings where id=p.booking_id for update;
 if b.status<>'reserved' or b.expires_at<now() then raise exception 'RESERVATION_EXPIRED'; end if;
 update payments set status='paid',method=p_method,provider_ref=p_ref,verified_by=auth.uid(),verified_at=now() where id=p.id;
 perform _issue_tickets(b.id);
 insert into audit_logs(actor,action,entity,entity_id) values(auth.uid(),'confirm_payment','payment',p.id::text); end $$;

-- Atomic check-in: the row lock means two gates cannot both accept one ticket.
create or replace function check_in(p_token text, p_gate uuid) returns jsonb language plpgsql security definer set search_path=public as $$
declare t tickets; r text; info jsonb; begin
 if coalesce(my_role()::text,'') not in ('super_admin','stadium_admin','gate_staff') then raise exception 'FORBIDDEN'; end if;
 select * into t from tickets where token=p_token for update;
 if not found then r:='invalid';
 elsif t.status='used' then r:='already_used';
 elsif t.status in ('cancelled','refunded') then r:=t.status::text;
 else update tickets set status='used',used_at=now() where id=t.id; r:='valid'; end if;
 insert into ticket_scans(ticket_id,token_tail,gate_id,staff_id,result) values(t.id,right(p_token,6),p_gate,auth.uid(),r);
 select jsonb_build_object('holder',t.holder_name,'seat',t.seat_code,'section',sc.name,'match',m.title) into info
 from match_sections ms join sections sc on sc.id=ms.section_id join matches m on m.id=ms.match_id where ms.id=t.match_section_id;
 return jsonb_build_object('result',r)||coalesce(info,'{}'::jsonb); end $$;

-- Open-entry counter. Never exceeds capacity; corrections (negative) need admin.
create or replace function open_entry_add(p_ms uuid, p_delta int, p_reason text default null) returns int language plpgsql security definer set search_path=public as $$
declare cap int; v_mode booking_mode; occ int; rl text := coalesce(my_role()::text,''); begin
 if rl not in ('super_admin','stadium_admin','gate_staff') then raise exception 'FORBIDDEN'; end if;
 if p_delta<0 and rl='gate_staff' then raise exception 'FORBIDDEN'; end if;
 select capacity,mode into cap,v_mode from match_sections where id=p_ms;
 if v_mode is distinct from 'open_entry' then raise exception 'NOT_OPEN_ENTRY'; end if;
 insert into entry_counts(match_section_id) values(p_ms) on conflict do nothing;
 select occupancy into occ from entry_counts where match_section_id=p_ms for update;
 if occ+p_delta>cap then raise exception 'CAPACITY_REACHED'; end if;
 if occ+p_delta<0 then raise exception 'BAD_COUNT'; end if;
 update entry_counts set occupancy=occ+p_delta where match_section_id=p_ms;
 insert into entry_log(match_section_id,delta,reason,staff_id) values(p_ms,p_delta,p_reason,auth.uid());
 return occ+p_delta; end $$;

revoke execute on function reserve_booking(uuid,int,text,text), confirm_payment(uuid,text,text), check_in(text,uuid), open_entry_add(uuid,int,text), expire_reservations(), _issue_tickets(uuid) from public, anon;
grant execute on function reserve_booking(uuid,int,text,text), confirm_payment(uuid,text,text), check_in(text,uuid), open_entry_add(uuid,int,text) to authenticated;

insert into settings values('hold_minutes','10'),('max_tickets_per_booking','10') on conflict do nothing;
insert into footer_links(label,url,sort) values('GitHub: Hamza-Idiris','https://github.com/Hamza-Idiris',1);
