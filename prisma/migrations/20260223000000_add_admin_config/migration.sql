-- CreateTable
CREATE TABLE "admin_config" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "testCustomerName" TEXT NOT NULL DEFAULT 'Test Customer',
    "testCategory" TEXT NOT NULL DEFAULT 'House Cleaning',
    "testLocation" TEXT NOT NULL DEFAULT 'Tampa, FL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_config_pkey" PRIMARY KEY ("id")
);
