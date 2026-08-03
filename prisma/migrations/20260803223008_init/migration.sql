-- CreateTable
CREATE TABLE "ScaffoldCheck" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScaffoldCheck_pkey" PRIMARY KEY ("id")
);
