import { GiBreakingChain } from "react-icons/gi";

export default function Navbar() {
return ( <header className="relative z-50 flex min-h-11 shrink-0 items-center backdrop-blur-md border-b border-white/10 p-3"> <div className="flex max-h-full min-w-0 items-center gap-3 rounded-md px-3 py-1.5"> <span className="inline-flex shrink-0" aria-hidden> <GiBreakingChain className="size-11 text-mainwhite" /> </span> <span className="text-mainwhite font-main truncate text-3xl font-bold leading-none tracking-tighter lowercase">
unchained </span> </div> </header>
);
}
