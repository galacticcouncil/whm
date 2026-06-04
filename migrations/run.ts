import { migration } from "@whm/common";

migration.run().catch((e) => {
  console.error(e);
  process.exit(1);
});
