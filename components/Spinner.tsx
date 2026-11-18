"use client"
import Image from "next/image";

/** Full-page overlay shown while a server action runs. */
const Spinner = () => {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Working"
      className="z-50 fixed inset-0 flex justify-center items-center
                 bg-black/40 backdrop-blur-sm"
    >
      <Image
        src={"/spinner.svg"}
        width={200}
        height={200}
        alt=""
        loading="eager"
        className="w-30 h-30 relative z-20"
      />
      <span className="sr-only">Working…</span>
    </div>
  );
};

export default Spinner;
