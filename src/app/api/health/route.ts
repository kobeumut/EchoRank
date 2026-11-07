import { connection } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  await connection();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok", db: "ok" });
  } catch {
    return Response.json({ status: "degraded", db: "error" }, { status: 503 });
  }
}
