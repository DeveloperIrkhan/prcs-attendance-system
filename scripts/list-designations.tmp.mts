import "dotenv/config";
import { prisma } from "../lib/prisma";

const rows = await prisma.designation.findMany({
  orderBy: { title: "asc" },
  select: {
    title: true,
    approvalLevel: true,
    _count: { select: { employees: true } },
  },
});

for (const row of rows) {
  console.log(`${row.title} | ${row.approvalLevel} | employees=${row._count.employees}`);
}

await prisma.$disconnect();
