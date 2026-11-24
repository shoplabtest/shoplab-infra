-- Run against iam's database as a superuser: psql -d iam -v reader_password=... -f invoices-reader.sql
-- Gives shoplab-invoices a role that can read three columns of `users` and nothing else.
-- iam must keep these columns as they are: invoices selects `email` and `full_name` by name.
SELECT format('CREATE ROLE invoices_reader LOGIN PASSWORD %L', :'reader_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'invoices_reader') \gexec
SELECT format('ALTER ROLE invoices_reader PASSWORD %L', :'reader_password') \gexec

GRANT CONNECT ON DATABASE iam TO invoices_reader;
GRANT USAGE ON SCHEMA public TO invoices_reader;
GRANT SELECT (id, email, full_name) ON users TO invoices_reader;
