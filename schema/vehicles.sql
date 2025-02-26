-- Enable RLS (Row Level Security)
alter table vehicles enable row level security;

-- Create vehicles table
create table if not exists vehicles (
    id uuid default uuid_generate_v4() primary key,
    driver_id uuid references auth.users(id) not null,
    make text not null,
    model text not null,
    year integer not null,
    license_plate text not null,
    status text not null check (status in ('active', 'inactive', 'pending_approval')),
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Create index on driver_id for faster lookups
create index vehicles_driver_id_idx on vehicles(driver_id);

-- Add RLS policies
create policy "Users can view their own vehicles"
    on vehicles for select
    using (auth.uid() = driver_id);

create policy "Users can insert their own vehicles"
    on vehicles for insert
    with check (auth.uid() = driver_id);

create policy "Users can update their own vehicles"
    on vehicles for update
    using (auth.uid() = driver_id);

-- Add has_vehicle column to profiles table if it doesn't exist
do $$
begin
    if not exists (select 1 from information_schema.columns 
                  where table_name = 'profiles' and column_name = 'has_vehicle') then
        alter table profiles add column has_vehicle boolean default false;
    end if;
end$$;

-- Create function to update updated_at timestamp
create or replace function update_updated_at_column()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

-- Create trigger to automatically update updated_at
create trigger update_vehicles_updated_at
    before update on vehicles
    for each row
    execute function update_updated_at_column();

-- Create unique constraint on license plate
alter table vehicles add constraint unique_license_plate unique (license_plate);

-- Add comment to table
comment on table vehicles is 'Stores vehicle information for drivers';
