/* =====================================================================
   Tạo SQL login riêng cho ứng dụng (quyền tối thiểu: đọc/ghi dữ liệu).
   Chạy:
     sqlcmd -S localhost\PRN222 -E -i database\02_app_login.sql -v AppPassword="<mat-khau-manh>"
   Sau đó điền cùng mật khẩu vào DB_PASSWORD trong file .env
   Yêu cầu: SQL Server bật chế độ Mixed Mode (SQL Server and Windows Authentication).
   ===================================================================== */
SET NOCOUNT ON;
USE master;
GO
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'nail_app')
    CREATE LOGIN nail_app WITH PASSWORD = N'$(AppPassword)', DEFAULT_DATABASE = NailStudio, CHECK_POLICY = ON;
ELSE
    ALTER LOGIN nail_app WITH PASSWORD = N'$(AppPassword)';
GO
USE NailStudio;
GO
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'nail_app')
    CREATE USER nail_app FOR LOGIN nail_app;
GO
ALTER ROLE db_datareader ADD MEMBER nail_app;
ALTER ROLE db_datawriter ADD MEMBER nail_app;
GO
PRINT N'Login nail_app OK';
GO
