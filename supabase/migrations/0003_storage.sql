insert into storage.buckets(id,name,public) values('section-images','section-images',true),('team-logos','team-logos',true) on conflict (id) do nothing;
drop policy if exists "images public read" on storage.objects;
drop policy if exists "images admin write" on storage.objects;
create policy "images public read" on storage.objects for select using (bucket_id in ('section-images','team-logos'));
create policy "images admin write" on storage.objects for all to authenticated
 using (bucket_id in ('section-images','team-logos') and public.my_role() in ('super_admin','stadium_admin'))
 with check (bucket_id in ('section-images','team-logos') and public.my_role() in ('super_admin','stadium_admin'));
