"use client";

type Personal = {
  id: number;
  nombre: string;
};

interface SelectPersonalProps {
  personal: Personal[];
  value: number | "";
  onChange: (value: number | "") => void;
  label?: string;
}

export function SelectPersonal({
  personal,
  value,
  onChange,
}: SelectPersonalProps) {
  return (
    <div className="w-full lg:w-auto min-w-[250px]">
      {/* <label className="block text-sm font-medium text-gray-700 mb-1 text-left"> */}
      {/* {label} */}
      {/* </label> */}
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || "")}
        className="px-4 py-2  text-gray-900 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none bg-white text-left"
      >
        <option value="">Seleccionar Personal...</option>
        {personal.map((u) => (
          <option key={u.id} value={u.id}>
            {u.nombre}
          </option>
        ))}
      </select>
      {personal.length === 0 && (
        <p className="text-xs text-red-600 mt-1 text-left">
          No hay personal cargado
        </p>
      )}
    </div>
  );
}
