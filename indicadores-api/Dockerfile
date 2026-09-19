FROM python:3.11-slim

# 1. Dependencias base
RUN apt-get update && apt-get install -y \
    curl \
    gnupg2 \
    unixodbc-dev \
    krb5-user \
    apt-transport-https \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 2. Repositorio Microsoft — escritura directa
RUN curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
    | gpg --dearmor -o /usr/share/keyrings/microsoft-prod.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/debian/12/prod bookworm main" \
    > /etc/apt/sources.list.d/mssql-release.list

# 3. Instalar ODBC Driver 18
RUN apt-get update \
    && ACCEPT_EULA=Y apt-get install -y msodbcsql18 \
    && rm -rf /var/lib/apt/lists/*

# 3b. Pool de conexiones del driver manager.
# db.py pide pooling (pyodbc.pooling = True), pero en unixODBC el pool solo se
# activa si está declarado acá. Sin esto, cada request paga de nuevo el
# handshake TCP + TLS + login contra SRV-SQL2 — y hay endpoints que abren tres
# o cuatro conexiones. CPTimeout = segundos que una conexión queda disponible
# en el pool antes de cerrarse.
RUN printf '\n[ODBC]\nPooling=Yes\n' >> /etc/odbcinst.ini \
    && sed -i '/^\[ODBC Driver 18 for SQL Server\]/a CPTimeout=120' /etc/odbcinst.ini

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]

