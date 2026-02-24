from fastapi import FastAPI, HTTPException
import asyncpg
import os
from datetime import datetime
from collections import defaultdict
from pydantic import BaseModel
from typing import Optional

app = FastAPI(title="Grid-X Eligibility Service")

# Connect to the main PowerGuard database
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://powerguard_user:powerguard_password@localhost:5432/powerguard_db")

@app.on_event("startup")
async def startup():
    app.state.pool = await asyncpg.create_pool(DATABASE_URL)

@app.on_event("shutdown")
async def shutdown():
    await app.state.pool.close()

async def calculate_wheeling_potential(user_id: str, meter_id: str) -> dict:
    """
    Task 1: The Eligibility Algorithm
    Pulls the last 30 days of interval data and calculates potential excess surplus.
    """
    
    # Task 2: Financial Modeling (ZAR)
    wheeling_rate_per_kwh = 1.85
    municipal_haircut = 0.15
    
    # Task 4: Database Integration
    # Assuming PostgreSQL schema where meter_readings has columns: timestamp, power_kw_draw, power_kw_gen
    query = """
        SELECT timestamp, power_kw_draw, power_kw_gen
        FROM meter_readings
        WHERE meter_id = $1 AND timestamp >= NOW() - INTERVAL '30 days'
        ORDER BY timestamp ASC
    """
    
    try:
        async with app.state.pool.acquire() as connection:
            records = await connection.fetch(query, meter_id)
    except Exception as e:
        # Fails gracefully if this specific schema does not exist yet in the actual DB
        raise HTTPException(status_code=500, detail=f"Database schema mapping error: {str(e)}")

    if not records:
        return {
            "is_eligible": False,
            "estimated_monthly_zar": 0.0,
            "total_surplus_kwh": 0.0,
            "peak_surplus_time": None
        }

    total_surplus_kwh = 0.0
    hour_surplus = defaultdict(float)
    
    # Assume 15-minute intervals. Power (kW) * 0.25h = Energy (kWh)
    interval_duration_hours = 0.25
    
    for record in records:
        ts = record['timestamp']
        draw_kw = record['power_kw_draw'] or 0.0
        gen_kw = record['power_kw_gen'] or 0.0
        
        # Calculate: Surplus = Generation_kW - Load_kW
        surplus_kw = gen_kw - draw_kw
        
        # Only count positive Surplus (where Generation exceeds Load)
        if surplus_kw > 0:
            surplus_kwh = surplus_kw * interval_duration_hours
            total_surplus_kwh += surplus_kwh
            
            # Group by hour to identify when they have the most excess
            hour_str = ts.strftime('%H:00')
            hour_surplus[hour_str] += surplus_kwh
            
    # is_eligible: Boolean (True if surplus > 500kWh/month)
    is_eligible = total_surplus_kwh > 500.0
    
    # Formula: Estimated_Revenue = Sum(Surplus_kWh) * wheeling_rate_per_kwh * (1 - municipal_haircut)
    estimated_monthly_zar = total_surplus_kwh * wheeling_rate_per_kwh * (1 - municipal_haircut)
    
    # Finding the peak surplus time
    peak_surplus_time = max(hour_surplus, key=hour_surplus.get) if hour_surplus else None

    return {
        "is_eligible": is_eligible,
        "estimated_monthly_zar": round(estimated_monthly_zar, 2),
        "total_surplus_kwh": round(total_surplus_kwh, 2),
        "peak_surplus_time": peak_surplus_time
    }

class EligibilityResponse(BaseModel):
    is_eligible: bool
    estimated_monthly_zar: float
    peak_surplus_time: Optional[str]
    total_surplus_kwh: float

@app.get("/api/v1/gridx/eligibility/{meter_id}", response_model=EligibilityResponse)
async def gridx_eligibility(meter_id: str, user_id: str = "system"):
    """
    Task 3: The API Endpoint
    Returns is_eligible, estimated_monthly_zar, and peak_surplus_time based on historical solar generation vs load.
    """
    try:
        result = await calculate_wheeling_potential(user_id, meter_id)
        return result
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8082, reload=True)
