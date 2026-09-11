import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolverConvenio } from "@/lib/rrhh/legajoService";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  // parseInt puede dar NaN (?page=abc) y Prisma explota con take/skip NaN
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, parseInt(searchParams.get("pageSize") ?? "20", 10) || 20),
  );
  const search = (searchParams.get("search") ?? "").trim();

  const where = search
    ? {
        OR: [
          { nombre: { contains: search, mode: "insensitive" as const } },
          { sector: { contains: search, mode: "insensitive" as const } },
          { sectorRel: { nombre: { contains: search, mode: "insensitive" as const } } },
          { codigo: { contains: search, mode: "insensitive" as const } },
          { dni: { contains: search } },
        ],
      }
    : {};

  try {
    const [total, items] = await Promise.all([
      prisma.legajo.count({ where }),
      prisma.legajo.findMany({
        where,
        select: {
          id: true,
          codigo: true,
          nombre: true,
          sector: true,
          sectorRel: { select: { nombre: true } },
          estado: true,
        },
        orderBy: [{ nombre: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    // El sector "efectivo" es el del catálogo (sectorRel, vía el selector del
    // legajo individual) si está asignado; si no, se cae al campo de texto
    // legado. Mismo criterio que usa updateLegajo() al resincronizar
    // usuario.sector — así la vista general no muestra "—" para legajos que
    // sí tienen sector puesto en su ficha.
    const itemsConSector = items.map(({ sectorRel, ...l }) => ({
      ...l,
      sector: sectorRel?.nombre ?? l.sector ?? null,
    }));

    return NextResponse.json({
      items: itemsConSector,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (e) {
    console.error("GET legajos error:", e);
    return NextResponse.json({ error: "Error al listar legajos" }, { status: 500 });
  }
}

function genCodigo() {
  return `L-${Date.now().toString(36).toUpperCase()}`;
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON inválido" }, { status: 400 });
  }
  const { step1, step2, step3, step4, step5, step6 } = body ?? {};

  if (!step1?.nombre) {
    return NextResponse.json(
      { error: "step1.nombre es obligatorio" },
      { status: 400 },
    );
  }

  const convenio = await resolverConvenio(step3?.convenioId, step3?.categoriaId);

  try {
    const legajo = await prisma.legajo.create({
      data: {
        codigo: genCodigo(),
        estado: "ACTIVO",
        // step1
        nombre: step1.nombre,
        dni: step1.dni?.trim() || null,
        cuil: step1.cuil?.trim() || null,
        // fechaNacimiento: new Date(step1.fechaNacimiento),
        fechaNacimiento: step1.fechaNacimiento
          ? new Date(step1.fechaNacimiento)
          : null,
        lugarNacimiento: step1.lugarNacimiento,
        nacionalidad: step1.nacionalidad ?? "Argentina",
        sexo: step1.sexo,
        estadoCivil: step1.estadoCivil,
        altura: step1.altura ?? null,
        peso: step1.peso ?? null,
        manoHabil: step1.manoHabil,
        telefonoFijo: step1.telefonoFijo ?? null,
        telefonoCelular: step1.telefonoCelular,
        emailPersonal: step1.emailPersonal,
        antecedentesPenales: step1.antecedentesPenales ?? false,
        antecedentesDetalle: step1.antecedentesDetalle ?? null,
        aceptaPsicotecnico: step1.aceptaPsicotecnico ?? false,
        // step2
        calle: step2?.calle ?? null,
        numero: step2?.numero ?? null,
        piso: step2?.piso ?? null,
        depto: step2?.depto ?? null,
        codigoPostal: step2?.codigoPostal ?? null,
        localidad: step2?.localidad ?? null,
        provincia: step2?.provincia ?? null,
        comprobanteUrl: step2?.comprobanteUrl ?? null,
        ddjjConformidad: step2?.ddjjConformidad ?? false,
        // step3
        // Fecha de ingreso = momento en que se crea el legajo, no un dato que
        // se tipee a mano (se sacó "Fecha ingreso empleo" del wizard/editor y
        // se dejó de pedir "Fecha de inicio" acá; ver rrhh_fecha_ingreso_unica
        // en la memoria del proyecto). Es el mismo campo que usan los
        // gráficos de /rrhh (lib/rrhh/headcountDb.ts).
        fechaInicio: new Date(),
        fechaCese: step3?.fechaCese ? new Date(step3.fechaCese) : null,
        modalidadContrato: step3?.modalidadContrato ?? null,
        situacionRevista: step3?.situacionRevista ?? null,
        regimen: step3?.regimen ?? null,
        // convenio/categoria salen del catálogo: se guardan los ids y el nombre
        // resuelto, para que texto y FK no puedan divergir
        ...convenio,
        puestoInterno: step3?.puestoInterno ?? null,
        sector: step3?.sector ?? null,
        retribucionPactada: step3?.retribucionPactada ?? null,
        modalidadLiquidacion: step3?.modalidadLiquidacion ?? null,
        obraSocial: step3?.obraSocial ?? null,
        tipoServicio: step3?.tipoServicio ?? null,
        actividadEconomica: step3?.actividadEconomica ?? null,
        domicilioExplotacion: step3?.domicilioExplotacion ?? null,
        claveAltaArca: step3?.claveAltaArca || null,
        fechaEnvioAlta: step3?.fechaEnvioAlta
          ? new Date(step3.fechaEnvioAlta)
          : null,
        banco: step3?.banco ?? null,
        bancoOtro: step3?.bancoOtro ?? null,
        diaPago: step3?.diaPago ?? null,
        percibeSeguroDesempleo: step3?.percibeSeguroDesempleo ?? false,
        ddjjArt12: step3?.ddjjArt12 ?? false,
        // step4
        tieneCargasFamilia: step4?.tieneCargasFamilia ?? false,
        medioPagoAaff: step4?.medioPagoAaff ?? null,
        medioPagoAaffOtro: step4?.medioPagoAaffOtro ?? null,
        // step5
        estatura: step5?.estatura ?? null,
        pesoSalud: step5?.peso ?? null,
        presionMin: step5?.presionMin ?? null,
        presionMax: step5?.presionMax ?? null,
        patologiaNervioso: step5?.patologias?.nervioso ?? false,
        patologiaRespiratorio: step5?.patologias?.respiratorio ?? false,
        patologiaCirculatorio: step5?.patologias?.circulatorio ?? false,
        patologiaDigestivo: step5?.patologias?.digestivo ?? false,
        patologiaRenal: step5?.patologias?.renal ?? false,
        patologiaOseo: step5?.patologias?.oseo ?? false,
        patologiaSangre: step5?.patologias?.sangre ?? false,
        patologiaCancer: step5?.patologias?.cancer ?? false,
        patologiaCongenitas: step5?.patologias?.congenitas ?? false,
        patologiaEndocrinas: step5?.patologias?.endocrinas ?? false,
        patologiaGinecologicas: step5?.patologias?.ginecologicas ?? false,
        patologiaEmbarazo: step5?.patologias?.embarazo ?? false,
        patologiaOtras: step5?.patologias?.otras ?? false,
        patologiaChagas: step5?.patologias?.chagas ?? false,
        observacionesSalud: step5?.observacionesSalud ?? null,
        numeroSolicitud: step5?.numeroSolicitud ?? null,
        numeroPoliza: step5?.numeroPoliza ?? null,
        capitalAsegurado: step5?.capitalAsegurado ?? null,
        artCompania: step5?.artCompania ?? null,
        artNumeroContrato: step5?.artNumeroContrato ?? null,
        artCredencialEntregada: step5?.artCredencialEntregada ?? false,
        // step6
        aceptaClausulas: step6?.aceptaClausulas ?? false,
        jurisdiccion: step6?.jurisdiccion ?? "San Francisco, Córdoba",
        firmaEmpleado: step6?.firmaEmpleado ?? null,
        fechaFirma: step6?.fechaFirma ? new Date(step6.fechaFirma) : null,
        // relaciones
        estudios: {
          create: (step1.estudios ?? []).map((e: any) => ({
            nivel: e.nivel,
            institucion: e.institucion,
            desde: e.desde,
            hasta: e.hasta ?? null,
            titulo: e.titulo ?? null,
            enCurso: e.enCurso ?? false,
          })),
        },
        idiomas: {
          create: (step1.idiomas ?? []).map((i: any) => ({
            idioma: i.idioma,
            habla: i.habla,
            escritura: i.escritura,
          })),
        },
        familiares: {
          create: (step4?.familiares ?? []).map((f: any) => ({
            parentesco: f.parentesco,
            apellido: f.apellido,
            nombre: f.nombre,
            tipoDocumento: f.tipoDocumento ?? "DNI",
            numeroDocumento: f.numeroDocumento,
            fechaNacimiento: new Date(f.fechaNacimiento),
            nacionalidad: f.nacionalidad ?? "Argentina",
            telefono: f.telefono ?? null,
            ocupacion: f.ocupacion ?? null,
            convive: f.convive ?? false,
          })),
        },
        beneficiarios: {
          create: (step4?.beneficiarios ?? []).map((b: any) => ({
            apellidoNombre: b.apellidoNombre,
            tipoDocumento: b.tipoDocumento ?? "DNI",
            numeroDocumento: b.numeroDocumento,
            parentesco: b.parentesco,
            domicilio: b.domicilio,
            porcentaje: b.porcentaje,
          })),
        },
        antecedentesSrt: {
          create: (step5?.antecedentesSrt ?? []).map((a: any) => ({
            descripcion: a.descripcion,
            fecha: a.fecha ? new Date(a.fecha) : null,
            observaciones: a.observaciones ?? null,
          })),
        },
        equipos: {
          create: (step6?.equipos ?? []).map((eq: any) => ({
            tipo: eq.tipo,
            marca: eq.marca,
            modelo: eq.modelo,
            detalle: eq.detalle ?? null,
            numeroSerie: eq.numeroSerie,
            fechaEntrega: new Date(eq.fechaEntrega),
            estado: eq.estado,
            observaciones: eq.observaciones ?? null,
          })),
        },
      },
      select: { codigo: true },
    });

    return NextResponse.json({ legajoCodigo: legajo.codigo }, { status: 201 });
  } catch (e: any) {
    console.error("POST legajo error:", e);
    const duplicado = e?.code === "P2002";
    return NextResponse.json(
      { error: duplicado ? "DNI o CUIL ya existe" : "Error al crear legajo" },
      { status: duplicado ? 409 : 500 },
    );
  }
}
