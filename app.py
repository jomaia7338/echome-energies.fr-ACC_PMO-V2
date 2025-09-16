import streamlit as st
import geopandas as gpd
from shapely.geometry import Point
from utils.spatial import generate_buffers, intersect_layer
from utils.scoring import evaluate_acc_status

st.set_page_config(page_title="ACC/PMO Cartographie", layout="wide")

st.title("🗺️ Simulateur ACC/PMO — Cartographie réglementaire")

# Saisie du point de production
st.sidebar.header("📍 Point de production")
lon = st.sidebar.number_input("Longitude", value=5.548, format="%.6f")
lat = st.sidebar.number_input("Latitude", value=45.055, format="%.6f")

if lon and lat:
    point = Point(lon, lat)
    buffers = generate_buffers(point)

    st.sidebar.success("Buffers générés ✅")

    # Upload de couche cartographique
    st.sidebar.header("📥 Importer une couche")
    uploaded_file = st.sidebar.file_uploader("Fichier GeoJSON / SHP", type=["geojson", "shp"])

    if uploaded_file:
        layer = gpd.read_file(uploaded_file)
        layer = layer.to_crs("EPSG:2154")

        # Intersection
        results = intersect_layer(layer, buffers)

        # Évaluation ACC
        acc_status = evaluate_acc_status(results)

        # Affichage
        st.subheader("🧮 Résultat réglementaire")
        st.write(acc_status)

        st.subheader("📊 Détail par rayon")
        st.dataframe(results)

        st.map(layer.to_crs("EPSG:4326"))

else:
    st.warning("Veuillez saisir des coordonnées valides.")
