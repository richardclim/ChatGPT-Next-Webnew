import dynamic from "next/dynamic";

const VectorDebug = dynamic(() => import("@/app/components/vector-debug"), {
  ssr: false,
});

export const metadata = {
  title: "Vector Store Debug | NextChat",
  description: "View and explore LanceDB vector store contents",
};

export default function VectorDebugPage() {
  return (
    <main
      style={{
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
      }}
    >
      <VectorDebug />
    </main>
  );
}
