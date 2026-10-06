-- Run this entire file in your Supabase project's SQL Editor.
-- Videos are public to watch; only their anonymous owner can publish into
-- their own account folder. All table access is separately protected by RLS.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique
    check (username ~ '^[A-Za-z0-9_]{2,24}$'),
  created_at timestamptz not null default now()
);

create table if not exists public.shorts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  category text not null default 'Для тебя'
    check (category in ('Для тебя', 'Путешествия', 'Природа', 'Музыка', 'Еда')),
  video_path text not null unique,
  check (video_path like user_id::text || '/%.mp4'),
  created_at timestamptz not null default now()
);

create table if not exists public.likes (
  video_id uuid not null references public.shorts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (video_id, user_id)
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.shorts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 240),
  created_at timestamptz not null default now()
);

create index if not exists shorts_created_at_idx on public.shorts (created_at desc);
create index if not exists comments_video_created_at_idx on public.comments (video_id, created_at);

-- Give first-time visitors a stable, editable username and a real Supabase
-- anonymous-auth identity. Their session persists in this browser.
create or replace function public.create_shorts_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, username)
  values (new.id, 'creator_' || substr(new.id::text, 1, 8))
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.create_shorts_profile() from public, anon, authenticated;

drop trigger if exists on_auth_user_created_shorts_profile on auth.users;
create trigger on_auth_user_created_shorts_profile
  after insert on auth.users
  for each row execute procedure public.create_shorts_profile();

alter table public.profiles enable row level security;
alter table public.shorts enable row level security;
alter table public.likes enable row level security;
alter table public.comments enable row level security;

drop policy if exists "Public can read creator usernames" on public.profiles;
create policy "Public can read creator usernames"
  on public.profiles for select to anon, authenticated using (true);
drop policy if exists "Creators can create their own profile" on public.profiles;
create policy "Creators can create their own profile"
  on public.profiles for insert to authenticated with check (id = (select auth.uid()));
drop policy if exists "Creators can edit their own profile" on public.profiles;
create policy "Creators can edit their own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists "Anyone can read published shorts" on public.shorts;
create policy "Anyone can read published shorts"
  on public.shorts for select to anon, authenticated using (true);
drop policy if exists "Creators can publish their own shorts" on public.shorts;
create policy "Creators can publish their own shorts"
  on public.shorts for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists "Anyone can read likes" on public.likes;
create policy "Anyone can read likes"
  on public.likes for select to anon, authenticated using (true);
drop policy if exists "Users can like shorts as themselves" on public.likes;
create policy "Users can like shorts as themselves"
  on public.likes for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "Users can remove their own likes" on public.likes;
create policy "Users can remove their own likes"
  on public.likes for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists "Anyone can read comments" on public.comments;
create policy "Anyone can read comments"
  on public.comments for select to anon, authenticated using (true);
drop policy if exists "Users can comment as themselves" on public.comments;
create policy "Users can comment as themselves"
  on public.comments for insert to authenticated with check (user_id = (select auth.uid()));

grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.shorts, public.likes, public.comments to anon, authenticated;
grant insert, update on public.profiles to authenticated;
grant insert on public.shorts, public.likes, public.comments to authenticated;
grant delete on public.likes to authenticated;

-- Public read access makes published clips viewable without an account.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shorts-videos', 'shorts-videos', true, 52428800, array['video/mp4'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Anyone can watch published video files" on storage.objects;
create policy "Anyone can watch published video files"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'shorts-videos');
drop policy if exists "Creators can upload videos into their own folder" on storage.objects;
create policy "Creators can upload videos into their own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'shorts-videos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
drop policy if exists "Creators can clean up their own video files" on storage.objects;
create policy "Creators can clean up their own video files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'shorts-videos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
