"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import Link from "next/link";
import { InicioButton } from "@/components/ui/InicioButton";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, UserPlus, ChevronLeft, ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UsuarioActual } from "@/components/auth/UsuarioActual";

type Legajo = {
  id: number;
  codigo: string;
  nombre: string;
  sector: string | null;
};

type ApiResp = {
  items: Legajo[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

const PAGE_SIZE = 20;

export default function LegajosListPage() {
  return (
    <Suspense
      fallback={
        <div className="dark min-h-screen bg-[#111111] px-6 py-8 text-sm text-zinc-500">
          Cargando…
        </div>
      }
    >
      <LegajosContent />
    </Suspense>
  );
}

function LegajosContent() {
  const router = useRouter();
  const sp = useSearchParams();

  const initialSearch = sp.get("search") ?? "";
  const initialPage = parseInt(sp.get("page") ?? "1", 10);

  const [search, setSearch] = useState(initialSearch);
  const [debounced, setDebounced] = useState(initialSearch);
  const [page, setPage] = useState(initialPage);
  const [data, setData] = useState<ApiResp | null>(null);
  const [loading, setLoading] = useState(false);

  // Debounce búsqueda 350ms y resetear a página 1
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [search]);

  // Sincronizar URL (?search=&page=)
  useEffect(() => {
    const params = new URLSearchParams();
    if (debounced) params.set("search", debounced);
    if (page > 1) params.set("page", String(page));
    router.replace(`/rrhh/legajos${params.toString() ? `?${params}` : ""}`);
  }, [debounced, page, router]);

  // Fetch
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      if (debounced) params.set("search", debounced);
      const res = await fetch(`/api/rrhh/legajos?${params}`);
      const json: ApiResp = await res.json();
      setData(json);
    } finally {
      setLoading(false);
    }
  }, [page, debounced]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const totalPages = data?.totalPages ?? 1;
  const total = data?.total ?? 0;
  const from = data ? (data.page - 1) * data.pageSize + 1 : 0;
  const to = data ? Math.min(data.page * data.pageSize, data.total) : 0;

  return (
    // `dark` + el mismo fondo #111111 que /deposito, /compras y /ventas: los
    // componentes de shadcn (Table, Input, Button) resuelven sus variables
    // contra el bloque .dark de globals.css, así que alcanza con envolver.
    <div className="dark min-h-screen bg-[#111111] text-white">
    <div className="container mx-auto px-6 py-8">
      <div className="flex items-center justify-between gap-3 mb-4">
        <InicioButton label="Inicio" iconSize={16} className="text-sm text-zinc-500 hover:text-yellow-400 transition-colors" />
        <UsuarioActual className="text-zinc-500" />
      </div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-yellow-400 font-bold text-xl uppercase tracking-wide">Legajos</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {total.toLocaleString("es-AR")} legajos en el sistema.
          </p>
        </div>
        <Link
          href="/rrhh/legajos/nuevo"
          className="inline-flex items-center text-sm text-zinc-300 border border-zinc-700 rounded-md px-3 py-1.5 hover:bg-zinc-800 hover:text-yellow-400 transition-colors"
        >
          <ChevronLeft className="h-4 w-5 mr-2" />
          Nuevo legajo
        </Link>
      </div>

      {/* Buscador */}
      <div className="relative mb-4 max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Buscar por nombre, sector, DNI o legajo…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Tabla */}
      <div className="rounded-lg bg-[#171717] border border-zinc-800 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-[#1f1f1f] hover:bg-[#1f1f1f]">
              <TableHead className="w-[110px] text-[10px] font-semibold uppercase tracking-wider text-zinc-500 border-b border-zinc-800">Legajo</TableHead>
              <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 border-b border-zinc-800">Nombre</TableHead>
              <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 border-b border-zinc-800">Sector</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="text-center text-sm text-zinc-600 py-8"
                >
                  Cargando…
                </TableCell>
              </TableRow>
            )}
            {!loading && data?.items.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="text-center text-sm text-zinc-600 py-8"
                >
                  Sin resultados.
                </TableCell>
              </TableRow>
            )}
            {!loading &&
              data?.items.map((l) => (
                <TableRow key={l.id} className="cursor-pointer border-b border-zinc-800/60 hover:bg-[#1f1f1f]">
                  <TableCell className="font-mono text-xs text-zinc-400">
                    <Link href={`/rrhh/legajos/${l.id}`} className="block">
                      {l.codigo}
                    </Link>
                  </TableCell>
                  <TableCell className="text-zinc-100">
                    <Link href={`/rrhh/legajos/${l.id}`} className="block">
                      {l.nombre}
                    </Link>
                  </TableCell>
                  <TableCell className="text-zinc-500">
                    {l.sector ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>

      {/* Paginación */}
      <div className="flex items-center justify-between mt-4">
        <p className="text-sm text-zinc-500">
          {total > 0
            ? `Mostrando ${from}–${to} de ${total.toLocaleString("es-AR")}`
            : ""}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-zinc-400">
            Página {page} de {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || loading}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
    </div>
  );
}

