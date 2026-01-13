
  import { createRoot } from "react-dom/client";
   import App from "./App";
  import "./index.css";
import { SocketProvider } from "./components/SocketProvider";
import { Toaster } from "sonner";

createRoot(document.getElementById("root")!).render(
  <SocketProvider>
    <Toaster position="top-left" richColors />
    <App />
  </SocketProvider>
);
  
