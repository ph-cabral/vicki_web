import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma"; 
export const dynamic = "force-dynamic";

const RELOJES = [
  { ip: "10.10.0.12", nombre: "Oficina" },
  { ip: "10.10.0.30", nombre: "Fabrica" },
  { ip: "10.10.0.92", nombre: "Lilser" },
];
const USER = process.env.HIKVISION_USER ?? "admin";
// Sin default hardcodeado: la credencial tiene que venir del entorno.
const PASS = process.env.HIKVISION_PASS ?? "";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
const SEXO_MAP: Record<string, string> = {
  male: "M",
  female: "F",
  unknown: "X",
};

type CreatePayload = {
  employeeNo: string;
  name: string;
  userType?: string;
  gender?: string;
  Valid?: { enable: boolean; beginTime: string; endTime: string };
  password?: string;
  doorRight?: string;
  RightPlan?: Array<{ doorNo: number; planTemplateNo: string }>;
  ips?: string[];
};

async function crearEnReloj(
  ip: string,
  userInfo: Omit<CreatePayload, "ips">,
): Promise<{ ip: string; ok: boolean; error?: string }> {
  const body = {
    UserInfo: {
      employeeNo: userInfo.employeeNo,
      name: userInfo.name,
      userType: userInfo.userType ?? "normal",
      gender: userInfo.gender ?? "unknown",  
      Valid: userInfo.Valid ?? {
        enable: true,
        beginTime: "2020-01-01T00:00:00",
        endTime: "2037-12-31T23:59:59",
      },
      doorRight: userInfo.doorRight ?? "1",
      RightPlan: userInfo.RightPlan ?? [
        { doorNo: 1, planTemplateNo: "1" },
      ],
      ...(userInfo.password ? { password: userInfo.password } : {}),
    },
  };

  try {
    const res = await fetch(
      `http://${ip}/ISAPI/AccessControl/UserInfo/Record?format=json`,
      {
        method: "POST",
        headers: {
          Authorization: AUTH,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      },
    );

    const txt = await res.text();
    if (!res.ok) return { ip, ok: false, error: `HTTP ${res.status}: ${txt}` };

    // La API devuelve statusCode "1" como string en el XML o JSON de respuesta
    let data: any;
    try { data = JSON.parse(txt); } catch { data = {}; }

    const status = data?.statusCode ?? data?.ResponseStatus?.statusCode;
    if (status && Number(status) !== 1) {
      return { ip, ok: false, error: data?.ResponseStatus?.statusString ?? txt };
    }

    return { ip, ok: true };
  } catch (e: any) {
    return { ip, ok: false, error: e?.message ?? "Error de conexión" };
  }
}

// POST /api/rrhh/relojes/empleados/crear
// Body: CreatePayload
export async function POST(req: NextRequest) {
  let payload: CreatePayload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON inválido" }, { status: 400 });
  }

  const { ips, ...userInfo } = payload;

  if (!userInfo.employeeNo || !userInfo.name) {
    return NextResponse.json(
      { error: "employeeNo y name son obligatorios" },
      { status: 400 },
    );
  }

  const targets = ips?.length
    ? RELOJES.filter((r) => ips.includes(r.ip))
    : RELOJES;

  const results = await Promise.all(
    targets.map((r) => crearEnReloj(r.ip, userInfo)),
  );

  const respuesta = results.map((r) => ({
    reloj: RELOJES.find((x) => x.ip === r.ip)?.nombre ?? r.ip,
    ip: r.ip,
    ok: r.ok,
    error: r.error ?? null,
  }));

  const hayError = respuesta.some((r) => !r.ok);
  const status = hayError ? 207 : 200; // 207 Multi-Status si alguno falló



  if (respuesta.some((r) => r.ok)) {
    try {
      await prisma.legajo.upsert({
        where: { employeeNo: userInfo.employeeNo },
        update: {},
        create: {
          employeeNo: userInfo.employeeNo,
          codigo: userInfo.employeeNo,
          estado: "ACTIVO", // en mayúscula: mismo valor que usa el resto del sistema (OPC.estado)
          // fechaInicio = momento de creación del legajo, sin importar por
          // qué medio se dio de alta (wizard de RRHH o, como acá, alta desde
          // el reloj biométrico) — ver rrhh_fecha_ingreso_unica.
          fechaInicio: new Date(),
          nombre: userInfo.name,
          sexo: SEXO_MAP[userInfo.gender ?? "unknown"],
        },
      });
    } catch (e) {
      console.error("Error creando legajo:", e);
    }
  }

  return NextResponse.json({ resultados: respuesta }, { status });
}

