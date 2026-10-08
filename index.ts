export default async () => {
  console.log("TIPA FAQ Pipeline - ESM Entry Point");

  const mode = import.meta.env.MODE as "production" | "development";
  await process({ mode });
};
