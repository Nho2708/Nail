/* =====================================================================
   Lumière Nail Studio — SQL Server 2019 schema
   Chạy: sqlcmd -S localhost\PRN222 -E -i database\01_schema.sql
   Script idempotent: chạy lại nhiều lần không mất dữ liệu.
   KHÔNG chứa dữ liệu mẫu — toàn bộ mẫu nail, màu, dịch vụ, danh mục
   do admin nhập trong trang quản trị.
   ===================================================================== */
SET NOCOUNT ON;
GO
IF DB_ID(N'NailStudio') IS NULL
BEGIN
    CREATE DATABASE NailStudio COLLATE Vietnamese_CI_AS;
END
GO
USE NailStudio;
GO

/* ---------- Người dùng & phân quyền ---------- */
IF OBJECT_ID(N'dbo.Users', N'U') IS NULL
CREATE TABLE dbo.Users (
    Id            INT IDENTITY(1,1) CONSTRAINT PK_Users PRIMARY KEY,
    Email         NVARCHAR(160) NOT NULL CONSTRAINT UQ_Users_Email UNIQUE,
    PasswordHash  VARCHAR(200)  NOT NULL,
    FullName      NVARCHAR(60)  NOT NULL,
    Phone         VARCHAR(15)   NULL,
    Role          VARCHAR(10)   NOT NULL CONSTRAINT DF_Users_Role DEFAULT ('customer')
                  CONSTRAINT CK_Users_Role CHECK (Role IN ('admin','customer')),
    CreatedAt     DATETIME2(0)  NOT NULL CONSTRAINT DF_Users_CreatedAt DEFAULT (SYSDATETIME())
);
GO

IF OBJECT_ID(N'dbo.Sessions', N'U') IS NULL
CREATE TABLE dbo.Sessions (
    Token      CHAR(64)     NOT NULL CONSTRAINT PK_Sessions PRIMARY KEY,
    UserId     INT          NOT NULL CONSTRAINT FK_Sessions_Users REFERENCES dbo.Users(Id) ON DELETE CASCADE,
    ExpiresAt  DATETIME2(0) NOT NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Sessions_ExpiresAt')
    CREATE INDEX IX_Sessions_ExpiresAt ON dbo.Sessions(ExpiresAt);
GO

/* ---------- Danh mục mẫu, màu sơn, dịch vụ ---------- */
IF OBJECT_ID(N'dbo.Categories', N'U') IS NULL
CREATE TABLE dbo.Categories (
    Id        INT IDENTITY(1,1) CONSTRAINT PK_Categories PRIMARY KEY,
    Name      NVARCHAR(40)  NOT NULL,
    SortOrder INT           NOT NULL CONSTRAINT DF_Categories_Sort DEFAULT (0)
);
GO

IF OBJECT_ID(N'dbo.Colors', N'U') IS NULL
CREATE TABLE dbo.Colors (
    Id        INT IDENTITY(1,1) CONSTRAINT PK_Colors PRIMARY KEY,
    Name      NVARCHAR(40) NOT NULL,
    Hex       CHAR(7)      NOT NULL CONSTRAINT CK_Colors_Hex CHECK (Hex LIKE '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
    Finish    VARCHAR(10)  NOT NULL CONSTRAINT DF_Colors_Finish DEFAULT ('gloss')
              CONSTRAINT CK_Colors_Finish CHECK (Finish IN ('gloss','matte','chrome','cateye')),
    SortOrder INT          NOT NULL CONSTRAINT DF_Colors_Sort DEFAULT (0)
);
GO

IF OBJECT_ID(N'dbo.Services', N'U') IS NULL
CREATE TABLE dbo.Services (
    Id           INT IDENTITY(1,1) CONSTRAINT PK_Services PRIMARY KEY,
    Name         NVARCHAR(80)  NOT NULL,
    Description  NVARCHAR(300) NULL,
    PriceFrom    INT           NOT NULL CONSTRAINT DF_Services_Price DEFAULT (0) CONSTRAINT CK_Services_Price CHECK (PriceFrom >= 0),
    DurationMin  INT           NOT NULL CONSTRAINT DF_Services_Duration DEFAULT (60) CONSTRAINT CK_Services_Duration CHECK (DurationMin >= 0),
    ImageUrl     NVARCHAR(300) NULL,
    SortOrder    INT           NOT NULL CONSTRAINT DF_Services_Sort DEFAULT (0),
    IsActive     BIT           NOT NULL CONSTRAINT DF_Services_Active DEFAULT (1)
);
GO

/* ---------- Mẫu nail ---------- */
IF OBJECT_ID(N'dbo.Designs', N'U') IS NULL
CREATE TABLE dbo.Designs (
    Id          INT IDENTITY(1,1) CONSTRAINT PK_Designs PRIMARY KEY,
    Title       NVARCHAR(80)  NOT NULL,
    Description NVARCHAR(500) NULL,
    ImageUrl    NVARCHAR(300) NOT NULL,
    ThumbUrl    NVARCHAR(300) NULL,
    CategoryId  INT           NULL CONSTRAINT FK_Designs_Categories REFERENCES dbo.Categories(Id) ON DELETE SET NULL,
    ColorId     INT           NULL CONSTRAINT FK_Designs_Colors REFERENCES dbo.Colors(Id) ON DELETE SET NULL,
    Price       INT           NOT NULL CONSTRAINT DF_Designs_Price DEFAULT (0) CONSTRAINT CK_Designs_Price CHECK (Price >= 0),
    IsFeatured  BIT           NOT NULL CONSTRAINT DF_Designs_Featured DEFAULT (0),
    IsActive    BIT           NOT NULL CONSTRAINT DF_Designs_Active DEFAULT (1),
    Views       INT           NOT NULL CONSTRAINT DF_Designs_Views DEFAULT (0),
    CreatedAt   DATETIME2(0)  NOT NULL CONSTRAINT DF_Designs_CreatedAt DEFAULT (SYSDATETIME())
);
GO

IF COL_LENGTH(N'dbo.Designs', N'ThumbUrl') IS NULL
    ALTER TABLE dbo.Designs ADD ThumbUrl NVARCHAR(300) NULL;
GO

/* ---------- Lịch hẹn & yêu cầu tư vấn ---------- */
IF OBJECT_ID(N'dbo.Bookings', N'U') IS NULL
CREATE TABLE dbo.Bookings (
    Id           INT IDENTITY(1,1) CONSTRAINT PK_Bookings PRIMARY KEY,
    Kind         VARCHAR(10)   NOT NULL CONSTRAINT DF_Bookings_Kind DEFAULT ('booking')
                 CONSTRAINT CK_Bookings_Kind CHECK (Kind IN ('booking','consult')),
    UserId       INT           NULL CONSTRAINT FK_Bookings_Users REFERENCES dbo.Users(Id) ON DELETE SET NULL,
    FullName     NVARCHAR(60)  NOT NULL,
    Phone        VARCHAR(15)   NOT NULL,
    Email        NVARCHAR(160) NULL,
    BookingDate  DATE          NULL,
    BookingTime  CHAR(5)       NULL,
    ServiceId    INT           NULL CONSTRAINT FK_Bookings_Services REFERENCES dbo.Services(Id) ON DELETE SET NULL,
    DesignId     INT           NULL CONSTRAINT FK_Bookings_Designs REFERENCES dbo.Designs(Id) ON DELETE SET NULL,
    ColorId      INT           NULL CONSTRAINT FK_Bookings_Colors REFERENCES dbo.Colors(Id),
    CustomColor  CHAR(7)       NULL,
    Note         NVARCHAR(500) NULL,
    Status       VARCHAR(10)   NOT NULL CONSTRAINT DF_Bookings_Status DEFAULT ('pending')
                 CONSTRAINT CK_Bookings_Status CHECK (Status IN ('pending','confirmed','done','cancelled')),
    NotifyResult NVARCHAR(1000) NULL,
    CreatedAt    DATETIME2(0)  NOT NULL CONSTRAINT DF_Bookings_CreatedAt DEFAULT (SYSDATETIME()),
    CONSTRAINT CK_Bookings_Schedule CHECK (Kind = 'consult' OR (BookingDate IS NOT NULL AND BookingTime IS NOT NULL))
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Bookings_Slot')
    CREATE INDEX IX_Bookings_Slot ON dbo.Bookings(BookingDate, BookingTime) INCLUDE (Status);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Bookings_User')
    CREATE INDEX IX_Bookings_User ON dbo.Bookings(UserId);
GO

/* ---------- Thống kê truy cập ---------- */
IF OBJECT_ID(N'dbo.Visits', N'U') IS NULL
CREATE TABLE dbo.Visits (
    Id         BIGINT IDENTITY(1,1) CONSTRAINT PK_Visits PRIMARY KEY,
    VisitorId  VARCHAR(64)   NOT NULL,
    Path       NVARCHAR(200) NOT NULL,
    Referrer   NVARCHAR(300) NULL,
    Device     VARCHAR(10)   NULL,
    CreatedAt  DATETIME2(0)  NOT NULL CONSTRAINT DF_Visits_CreatedAt DEFAULT (SYSDATETIME())
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Visits_CreatedAt')
    CREATE INDEX IX_Visits_CreatedAt ON dbo.Visits(CreatedAt) INCLUDE (VisitorId, Device, Referrer);
GO

/* ---------- Cài đặt giao diện & thông báo (key/value JSON) ---------- */
IF OBJECT_ID(N'dbo.Settings', N'U') IS NULL
CREATE TABLE dbo.Settings (
    SettingKey   VARCHAR(60)    NOT NULL CONSTRAINT PK_Settings PRIMARY KEY,
    SettingValue NVARCHAR(2000) NOT NULL
);
GO

PRINT N'NailStudio schema OK';
GO
