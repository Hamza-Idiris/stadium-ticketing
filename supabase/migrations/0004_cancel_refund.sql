-- Cancel a match: stops sales, releases unpaid holds, cancels valid tickets. Paid payments stay 'paid' until refunded.
create or replace function cancel_match(p_match uuid) returns void language plpgsql security definer set search_path=public as $$
begin
 if coalesce(my_role()::text,'') not in ('super_admin','stadium_admin') then raise exception 'FORBIDDEN'; end if;
 update matches set status='cancelled' where id=p_match;
 if not found then raise exception 'NOT_FOUND'; end if;
 update payments set status='failed' where status='pending' and booking_id in
  (select b.id from bookings b join match_sections ms on ms.id=b.match_section_id where ms.match_id=p_match);
 update bookings set status='cancelled' where status='reserved' and match_section_id in (select id from match_sections where match_id=p_match);
 delete from booking_seats where booking_id in (select id from bookings where status='cancelled');
 update tickets set status='cancelled' where status='valid' and match_section_id in (select id from match_sections where match_id=p_match);
 insert into audit_logs(actor,action,entity,entity_id) values(auth.uid(),'cancel_match','match',p_match::text);
end $$;

-- Full refund record: invalidates the booking's tickets, frees seats. The money itself is returned via the payment provider.
create or replace function refund_payment(p_payment uuid, p_reason text) returns void language plpgsql security definer set search_path=public as $$
declare p payments; begin
 if coalesce(my_role()::text,'') not in ('super_admin','stadium_admin') then raise exception 'FORBIDDEN'; end if;
 select * into p from payments where id=p_payment for update;
 if not found or p.status<>'paid' then raise exception 'PAYMENT_NOT_PAID'; end if;
 if exists(select 1 from tickets where booking_id=p.booking_id and status='used') then raise exception 'TICKETS_USED'; end if;
 update tickets set status='refunded' where booking_id=p.booking_id and status in ('valid','cancelled');
 update bookings set status='cancelled' where id=p.booking_id;
 delete from booking_seats where booking_id=p.booking_id;
 update payments set status='refunded' where id=p.id;
 insert into refunds(payment_id,amount,reason,processed_by) values(p.id,p.amount,p_reason,auth.uid());
 insert into audit_logs(actor,action,entity,entity_id,detail) values(auth.uid(),'refund_payment','payment',p.id::text,jsonb_build_object('reason',p_reason));
end $$;
revoke execute on function cancel_match(uuid), refund_payment(uuid,text) from public, anon;
grant execute on function cancel_match(uuid), refund_payment(uuid,text) to authenticated;
