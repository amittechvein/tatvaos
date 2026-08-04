# Multi-stage. The runtime image carries no SDK, no source and no build tools -
# a smaller attack surface as much as a smaller image.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY TatvaOS.Api.csproj .
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=build /app .

# Never run as root. A container escape should not land on a root shell.
RUN adduser --disabled-password --gecos "" --uid 10001 apiuser \
 && chown -R apiuser:apiuser /app
USER apiuser

ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://localhost:8080/health || exit 1

ENTRYPOINT ["dotnet", "TatvaOS.Api.dll"]
