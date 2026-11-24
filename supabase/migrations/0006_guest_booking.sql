-- Allow bookings without a registered user account (guest checkout)
alter table bookings alter column user_id drop not null;

create or replace function reserve_booking(p_ms uuid, p_qty int, p_name text, p_phone text) returns uuid language plpgsql security definer set search_path=public, extensions as $$
declare ms match_sections; s sections; m matches; avail int; st int; bid uuid; maxq int := app_setting('max_tickets_per_booking','10')::int; begin
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

grant execute on function reserve_booking(uuid,int,text,text) to anon, authenticated;
